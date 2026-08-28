import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { ok, fail, notImplemented } from "@/lib/api/response";
import { ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import { createChurchGroupSchema } from "@/schemas/church-group";

export async function GET(_req: NextRequest) {
  return notImplemented("GET /api/church-group");
}

// PUT /api/church-group — creates a new church group (issue #24; note this
// diverges from PRD §22.1's "update" semantics — see spec for #24).
//
// Does NOT use requireAuth: the creator has no `users` row yet, so
// requireAuth would always 401. Instead the whole creation runs as one
// atomic SECURITY DEFINER RPC (create_church_group), called via the
// RLS-scoped anon client with the creator's Clerk JWT.
export async function PUT(req: NextRequest) {
  try {
    const { userId: clerkId, getToken } = await auth();
    if (!clerkId) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }

    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }

    const body = await req.json().catch(() => null);
    const parsedResult = createChurchGroupSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const parsed = parsedResult.data;

    const user = await currentUser();
    const creatorName = deriveCreatorName(user);
    const creatorEmail = user?.primaryEmailAddress?.emailAddress ?? null;

    const supabase = getSupabaseClient(jwt);
    const { data, error } = await supabase.rpc("create_church_group", {
      p_name: parsed.name,
      p_timezone: parsed.timezone,
      p_denomination: parsed.denomination ?? null,
      p_logo_url: parsed.logoUrl ?? null,
      p_creator_name: creatorName,
      p_creator_email: creatorEmail,
    });

    if (error) {
      if (error.message.includes("USER_ALREADY_IN_GROUP")) {
        return fail("User already belongs to a church group", ErrorCode.CONFLICT, 409);
      }
      if (error.message.includes("UNAUTHENTICATED")) {
        return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
      }
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok(data, 201);
  } catch {
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// Derives a non-empty display name (users.name is NOT NULL) from Clerk user
// data, falling back to "Admin" when nothing usable is available. Truncated
// to 100 chars to match the users.name column.
function deriveCreatorName(user: Awaited<ReturnType<typeof currentUser>> | null): string {
  const candidates = [
    user?.fullName,
    [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim(),
    user?.username,
    user?.primaryEmailAddress?.emailAddress?.split("@")[0],
  ];

  const name = candidates.find((candidate) => candidate && candidate.trim().length > 0);
  return (name ?? "Admin").trim().slice(0, 100);
}
