import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { createSongSchema, songSearchQuerySchema, isValidSongKey } from "@/schemas/songs";

export type SongResponse = {
  id: string;
  title: string;
  artist: string | null;
  defaultKey: string | null;
  bpm: number | null;
  tags: string[];
  createdBy: string | null;
  createdAt: string;
};

function toSongResponse(row: {
  id: string;
  title: string;
  artist: string | null;
  default_key: string | null;
  bpm: number | null;
  tags: string[] | null;
  created_by: string | null;
  created_at: string;
}): SongResponse {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    defaultKey: row.default_key,
    bpm: row.bpm,
    tags: row.tags ?? [],
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// GET /api/songs — the group's song catalog, optionally filtered by a
// case-insensitive partial match on title/artist. Group members and above
// read the catalog; guests do not.
export async function listSongs(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader", "member"]);

    const parsedResult = songSearchQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const { q } = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    let query = supabase
      .from("songs")
      .select("id, title, artist, default_key, bpm, tags, created_by, created_at")
      .eq("church_group_id", ctx.churchGroupId);

    if (q) {
      query = query.or(`title.ilike.%${q}%,artist.ilike.%${q}%`);
    }

    const { data, error } = await query.order("title", { ascending: true });

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ songs: (data ?? []).map(toSongResponse) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/songs — Set Leader / Admin adds a song to the group's catalog.
// Manual entry only (no Spotify enrichment) — spotify_id stays null.
export async function createSong(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const body = await req.json().catch(() => null);
    const parsedResult = createSongSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const parsed = parsedResult.data;

    // BR-09: key membership is checked here (not in Zod) so a malformed body
    // is 400 but an invalid key value is 422.
    if (parsed.default_key != null && !isValidSongKey(parsed.default_key)) {
      return fail("Invalid musical key", ErrorCode.VALIDATION_FAILED, 422);
    }

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
    // touch.
    const payload = {
      church_group_id: ctx.churchGroupId,
      title: parsed.title,
      artist: parsed.artist ?? null,
      default_key: parsed.default_key ?? null,
      bpm: parsed.bpm ?? null,
      tags: parsed.tags ?? null,
      created_by: ctx.userId,
    } as unknown as Database["public"]["Tables"]["songs"]["Insert"];

    const { data, error } = await supabase
      .from("songs")
      .insert(payload)
      .select("id, title, artist, default_key, bpm, tags, created_by, created_at")
      .single();

    if (error || !data) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ song: toSongResponse(data) }, 201);
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
