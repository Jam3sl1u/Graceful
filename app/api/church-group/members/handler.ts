import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { UserRole, VocalCapability } from "@/types/domain";

export type DirectoryMember = {
  id: string; // users.id
  name: string;
  role: UserRole;
  vocalCapability: VocalCapability; // 'none' when the user has no member_profile
  instruments: { id: string; name: string }[];
  availabilityStatus: null; // placeholder for #34 — see spec OPEN QUESTION 1
  email?: string | null; // present ONLY when caller is admin
  phone?: string | null; // present ONLY when caller is admin
};

export async function getChurchGroupMembers(
  req: NextRequest,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader", "member"]);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const [usersRes, profilesRes, miRes, instrRes] = await Promise.all([
      supabase
        .from("users")
        .select("id, name, role, email, phone")
        .eq("church_group_id", ctx.churchGroupId),
      supabase.from("member_profiles").select("id, user_id, vocal_capability"),
      supabase.from("member_instruments").select("member_profile_id, instrument_id"),
      supabase.from("instruments").select("id, name").eq("church_group_id", ctx.churchGroupId),
    ]);

    if (usersRes.error || profilesRes.error || miRes.error || instrRes.error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const instrumentNameById = new Map<string, string>();
    for (const instrument of instrRes.data ?? []) {
      instrumentNameById.set(instrument.id, instrument.name);
    }

    const profileByUserId = new Map<
      string,
      { profileId: string; vocalCapability: VocalCapability }
    >();
    for (const profile of profilesRes.data ?? []) {
      profileByUserId.set(profile.user_id, {
        profileId: profile.id,
        vocalCapability: profile.vocal_capability,
      });
    }

    const instrumentsByProfileId = new Map<string, { id: string; name: string }[]>();
    for (const mi of miRes.data ?? []) {
      const name = instrumentNameById.get(mi.instrument_id);
      if (!name) continue; // skip entries with no matching instrument
      const existing = instrumentsByProfileId.get(mi.member_profile_id) ?? [];
      existing.push({ id: mi.instrument_id, name });
      instrumentsByProfileId.set(mi.member_profile_id, existing);
    }

    const members: DirectoryMember[] = (usersRes.data ?? []).map((user) => {
      const profile = profileByUserId.get(user.id);
      const member: DirectoryMember = {
        id: user.id,
        name: user.name,
        role: user.role,
        vocalCapability: profile ? profile.vocalCapability : "none",
        instruments: profile ? (instrumentsByProfileId.get(profile.profileId) ?? []) : [],
        availabilityStatus: null,
      };
      if (ctx.role === "admin") {
        member.email = user.email;
        member.phone = user.phone;
      }
      return member;
    });

    return ok({ members });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

