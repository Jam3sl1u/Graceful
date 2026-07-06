import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { ok, fail, notImplemented } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { createChurchGroupSchema } from "@/schemas/church-group";

export async function GET(_req: NextRequest) {
  return notImplemented("GET /api/church-group");
}

// Creates a church group, assigns the creator as admin, auto-generates a
// unique invite code, and seeds the 9 default instruments (#24).
//
// The creator is a brand-new Clerk user with no `users` row yet, so this
// route uses Clerk `auth()` directly (not `requireAuth`, which 401s users
// without a `users` row). The entire bootstrap happens atomically inside the
// `create_church_group` SECURITY DEFINER RPC, called via the RLS-scoped
// Supabase client with the caller's JWT.
export async function PUT(req: NextRequest) {
  try {
    const { userId: clerkId, getToken } = await auth();
    if (!clerkId) {
      throw new ApiException("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }

    const body = await req.json().catch(() => null);
    const parsed = createChurchGroupSchema.safeParse(body);
    if (!parsed.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }

    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      throw new ApiException("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }

    const user = await currentUser();
    const name =
      [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
      user?.username ||
      "Admin";
    const email =
      user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? null;

    const supabase = getSupabaseClient(jwt);
    const { data, error } = await supabase.rpc("create_church_group", {
      p_name: parsed.data.name,
      p_timezone: parsed.data.timezone,
      p_denomination: parsed.data.denomination ?? null,
      p_logo_url: parsed.data.logo_url ?? null,
      p_user_name: name,
      p_user_email: email,
    });

    if (error?.code === "GR001") {
      return fail("You already belong to a church group", ErrorCode.CONFLICT, 409);
    }
    if (error) {
      throw new ApiException("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok(data, 201);
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
