import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { ok, fail } from "@/lib/api/response";
import { ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import { joinChurchGroupSchema } from "@/schemas/church-group";

// POST /api/church-group/join — joins an existing church group via invite
// code (issue #25).
//
// Does NOT use requireAuth: the joiner has no `users` row yet, so
// requireAuth would always 401. Instead the whole join runs as one atomic
// SECURITY DEFINER RPC (join_church_group), called via the RLS-scoped anon
// client with the joiner's Clerk JWT.
export async function POST(req: NextRequest) {
  try {
    const { userId: clerkId, getToken } = await auth();
    if (!clerkId) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }

    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }

    const body = await req.json().catch(() => null);
    const parsedResult = joinChurchGroupSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const parsed = parsedResult.data;

    const user = await currentUser();
    const memberName = deriveMemberName(user);
    const memberEmail = user?.primaryEmailAddress?.emailAddress ?? null;

    const supabase = getSupabaseClient(jwt);
    const { data, error } = await supabase.rpc("join_church_group", {
      p_invite_code: parsed.inviteCode,
      p_member_name: memberName,
      p_member_email: memberEmail,
    });

    if (error) {
      if (error.message.includes("INVALID_INVITE_CODE")) {
        return fail("Invalid or expired invite code", ErrorCode.VALIDATION_FAILED, 400);
      }
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
// data, falling back to "Member" when nothing usable is available. Truncated
// to 100 chars to match the users.name column.
function deriveMemberName(user: Awaited<ReturnType<typeof currentUser>> | null): string {
  const candidates = [
    user?.fullName,
    [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim(),
    user?.username,
    user?.primaryEmailAddress?.emailAddress?.split("@")[0],
  ];

  const name = candidates.find((candidate) => candidate && candidate.trim().length > 0);
  return (name ?? "Member").trim().slice(0, 100);
}
