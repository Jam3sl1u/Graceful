import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import { setSongFamiliaritySchema, songIdParamSchema } from "@/schemas/songs";

// PUT /api/songs/:id/familiarity — the caller records how well they know a
// song in their group's catalog (PRD §13.4). Writes only the caller's own
// row; admins, set leaders and members may all use it, guests may not.
export async function setSongFamiliarity(
  req: NextRequest,
  songId: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader", "member"]);

    if (!songIdParamSchema.safeParse(songId).success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const body = await req.json().catch(() => null);
    const parsed = setSongFamiliaritySchema.safeParse(body);
    if (!parsed.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data: song, error: songError } = await supabase
      .from("songs")
      .select("id")
      .eq("id", songId)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();
    if (songError) return fail("Internal error", ErrorCode.INTERNAL, 500);
    if (!song) return fail("Song not found", ErrorCode.NOT_FOUND, 404);

    const { data, error } = await supabase
      .from("song_familiarity")
      .upsert(
        {
          church_group_id: ctx.churchGroupId,
          user_id: ctx.userId,
          song_id: songId,
          level: parsed.data.level,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,song_id" },
      )
      .select("song_id, level")
      .single();
    if (error || !data) return fail("Internal error", ErrorCode.INTERNAL, 500);

    return ok({ songId: data.song_id, level: data.level });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
