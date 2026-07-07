import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuth, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import type { VocalCapability } from "@/types/domain";
import { updateProfileSchema } from "@/schemas/profile";

export type ProfileResponse = {
  userId: string; // users.id (the caller)
  vocalCapability: VocalCapability; // 'none' when no profile row exists yet
  bio: string | null;
  instruments: { id: string; name: string }[]; // read-only; [] when no profile / no instruments
};

// GET /api/profile — the caller's own member_profiles record + selected
// instruments. Ownership is enforced by RLS (user_id = auth_user_id()) and by
// scoping every query to ctx.userId; there is no role gate in the AC.
export async function getProfile(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data, error } = await supabase
      .from("member_profiles")
      .select("id, vocal_capability, bio")
      .eq("user_id", ctx.userId)
      .maybeSingle();

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    if (!data) {
      return ok({
        profile: {
          userId: ctx.userId,
          vocalCapability: "none",
          bio: null,
          instruments: [],
        },
      });
    }

    const instruments = await loadInstruments(supabase, data.id, ctx.churchGroupId);

    const profile: ProfileResponse = {
      userId: ctx.userId,
      vocalCapability: data.vocal_capability,
      bio: data.bio,
      instruments,
    };

    return ok({ profile });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// PUT /api/profile — updates (or creates, via upsert) the caller's own
// vocal_capability and bio. Instrument selection is out of scope (#31).
export async function updateProfile(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const body = await req.json().catch(() => null);
    const parsedResult = updateProfileSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const parsed = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    // The hand-rolled Insert type in lib/supabase/types.ts marks `created_at`
    // as required even though the DB column has a `now()` default (it isn't
    // generated from the live schema). Cast narrowly here rather than
    // widening the shared type or setting a value for a column we must not
    // touch (spec: no `created_at` / `updated_at` writes).
    const upsertPayload = {
      user_id: ctx.userId,
      vocal_capability: parsed.vocalCapability,
      bio: parsed.bio,
    } as unknown as Database["public"]["Tables"]["member_profiles"]["Insert"];

    const { data, error } = await supabase
      .from("member_profiles")
      .upsert(upsertPayload, { onConflict: "user_id" })
      .select("id, vocal_capability, bio")
      .maybeSingle();

    if (error || !data) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const instruments = await loadInstruments(supabase, data.id, ctx.churchGroupId);

    const profile: ProfileResponse = {
      userId: ctx.userId,
      vocalCapability: data.vocal_capability,
      bio: data.bio,
      instruments,
    };

    return ok({ profile });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// Loads the { id, name } instruments selected by a given member_profiles row,
// skipping any member_instruments entry whose instrument_id has no matching
// (group-scoped) instruments row. Mirrors app/api/church-group/members/handler.ts.
async function loadInstruments(
  supabase: SupabaseClient<Database>,
  memberProfileId: string,
  churchGroupId: string,
): Promise<{ id: string; name: string }[]> {
  const [miRes, instrRes] = await Promise.all([
    supabase
      .from("member_instruments")
      .select("member_profile_id, instrument_id")
      .eq("member_profile_id", memberProfileId),
    supabase.from("instruments").select("id, name").eq("church_group_id", churchGroupId),
  ]);

  if (miRes.error || instrRes.error) {
    throw new ApiException("Internal error", ErrorCode.INTERNAL, 500);
  }

  const instrumentNameById = new Map<string, string>();
  for (const instrument of instrRes.data ?? []) {
    instrumentNameById.set(instrument.id, instrument.name);
  }

  const instruments: { id: string; name: string }[] = [];
  for (const mi of miRes.data ?? []) {
    const name = instrumentNameById.get(mi.instrument_id);
    if (!name) continue; // skip entries with no matching instrument
    instruments.push({ id: mi.instrument_id, name });
  }

  return instruments;
}
