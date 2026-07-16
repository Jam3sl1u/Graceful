import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { isValidSongKey } from "@/schemas/songs";
import { reorderSetlistSchema, addSetlistSongSchema } from "@/schemas/setlists";
import { toSetlistResponse } from "@/app/api/service-weeks/[id]/setlist/handler";

type SetlistSongsRow = Database["public"]["Tables"]["setlist_songs"]["Row"];

export type SetlistSongResponse = {
  id: string;
  setlistId: string;
  songId: string;
  position: number;
  keyOverride: string | null; // null = using the song's default key
  defaultKey: string | null; // the song's catalog default_key (songs.default_key)
  effectiveKey: string | null; // keyOverride ?? defaultKey — the key to actually play
  isOverridden: boolean; // keyOverride != null
  notes: string | null;
};

export function toSetlistSongResponse(
  row: SetlistSongsRow,
  defaultKey: string | null,
): SetlistSongResponse {
  return {
    id: row.id,
    setlistId: row.setlist_id,
    songId: row.song_id,
    position: row.position,
    keyOverride: row.key_override,
    defaultKey,
    effectiveKey: row.key_override ?? defaultKey,
    isOverridden: row.key_override != null,
    notes: row.notes,
  };
}

type EditableSetlistResult =
  | { ok: true; setlist: { id: string; status: string } }
  | { ok: false; response: Response };

// Loads the parent setlist tenant-scoped and asserts it is editable
// (status = 'draft'). 404 if missing/other tenant, 409 if published.
async function loadEditableSetlist(
  supabase: SupabaseClient<Database>,
  setlistId: string,
  churchGroupId: string,
): Promise<EditableSetlistResult> {
  const { data, error } = await supabase
    .from("setlists")
    .select("id, status")
    .eq("id", setlistId)
    .eq("church_group_id", churchGroupId)
    .maybeSingle();

  if (error) {
    return { ok: false, response: fail("Internal error", ErrorCode.INTERNAL, 500) };
  }
  if (!data) {
    return { ok: false, response: fail("Setlist not found", ErrorCode.NOT_FOUND, 404) };
  }
  if (data.status !== "draft") {
    return {
      ok: false,
      response: fail(
        "Setlist is published. Unlock it before editing.",
        ErrorCode.CONFLICT,
        409,
      ),
    };
  }
  return { ok: true, setlist: data };
}

// Re-selects all setlist_songs for a setlist, ordered by position asc.
async function loadOrderedSongs(
  supabase: SupabaseClient<Database>,
  setlistId: string,
): Promise<{ data: SetlistSongsRow[] | null; error: unknown }> {
  return supabase
    .from("setlist_songs")
    .select("*")
    .eq("setlist_id", setlistId)
    .order("position", { ascending: true });
}

// Loads the setlist's songs (ordered by position) and joins each row to its
// song's default_key so the response can distinguish "using default" from
// "overridden this week". Returns fully-formed response objects.
async function loadSongResponses(
  supabase: SupabaseClient<Database>,
  setlistId: string,
): Promise<{ data: SetlistSongResponse[] | null; error: unknown }> {
  const { data: rows, error } = await loadOrderedSongs(supabase, setlistId);
  if (error) return { data: null, error };

  const songRows = rows ?? [];
  const songIds = [...new Set(songRows.map((r) => r.song_id))];

  const defaultKeyById = new Map<string, string | null>();
  if (songIds.length > 0) {
    const { data: songs, error: songsError } = await supabase
      .from("songs")
      .select("id, default_key")
      .in("id", songIds);
    if (songsError) return { data: null, error: songsError };
    for (const s of songs ?? []) {
      defaultKeyById.set(s.id, s.default_key ?? null);
    }
  }

  return {
    data: songRows.map((r) => toSetlistSongResponse(r, defaultKeyById.get(r.song_id) ?? null)),
    error: null,
  };
}

// PUT /api/setlists/:id — set_leader/admin only. Reorders the songs already
// in the setlist and sets per-song key overrides. Does not add/remove songs
// (see POST/DELETE below) — the songId set in the body must exactly match
// the setlist's current songs.
export async function reorderSetlist(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const body = await req.json().catch(() => null);
    const parsedResult = reorderSetlistSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const parsed = parsedResult.data;

    // BR-09: key membership is checked here (not in Zod) so a malformed body
    // is 400 but an invalid key value is 422.
    for (const entry of parsed.songs) {
      if (entry.keyOverride != null && !isValidSongKey(entry.keyOverride)) {
        return fail("Invalid musical key", ErrorCode.VALIDATION_FAILED, 422);
      }
    }

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const editable = await loadEditableSetlist(supabase, id, ctx.churchGroupId);
    if (!editable.ok) {
      return editable.response;
    }

    const bodySongIds = parsed.songs.map((entry) => entry.songId);
    if (new Set(bodySongIds).size !== bodySongIds.length) {
      return fail("Duplicate songId in request body", ErrorCode.VALIDATION_FAILED, 400);
    }

    const { data: currentRows, error: currentError } = await supabase
      .from("setlist_songs")
      .select("id, song_id")
      .eq("setlist_id", id);

    if (currentError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const currentSongIds = (currentRows ?? []).map((row) => row.song_id);
    const bodySet = new Set(bodySongIds);
    const currentSet = new Set(currentSongIds);
    const sameMembers =
      bodySet.size === currentSet.size && [...bodySet].every((songId) => currentSet.has(songId));
    if (!sameMembers) {
      return fail(
        "Song set does not match the setlist",
        ErrorCode.VALIDATION_FAILED,
        400,
      );
    }

    for (let i = 0; i < parsed.songs.length; i++) {
      const entry = parsed.songs[i]!;
      const { error: updateError } = await supabase
        .from("setlist_songs")
        .update({
          position: i + 1,
          key_override: entry.keyOverride ?? null,
        } as unknown as Database["public"]["Tables"]["setlist_songs"]["Update"])
        .eq("setlist_id", id)
        .eq("song_id", entry.songId);

      if (updateError) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }
    }

    const { data: songs, error } = await loadSongResponses(supabase, id);
    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ songs });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/setlists/:id/songs — set_leader/admin only. Adds one song to the
// setlist at the next position. BR-07: rejects duplicates.
export async function addSetlistSong(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const body = await req.json().catch(() => null);
    const parsedResult = addSetlistSongSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const parsed = parsedResult.data;

    // BR-09: key membership is checked here (not in Zod) so a malformed body
    // is 400 but an invalid key value is 422.
    if (parsed.keyOverride != null && !isValidSongKey(parsed.keyOverride)) {
      return fail("Invalid musical key", ErrorCode.VALIDATION_FAILED, 422);
    }

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const editable = await loadEditableSetlist(supabase, id, ctx.churchGroupId);
    if (!editable.ok) {
      return editable.response;
    }

    // Prevents cross-tenant adds and gives a clean 404 rather than a raw FK
    // error.
    const { data: song, error: songError } = await supabase
      .from("songs")
      .select("id")
      .eq("id", parsed.songId)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (songError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!song) {
      return fail("Song not found", ErrorCode.NOT_FOUND, 404);
    }

    // BR-07 duplicate check.
    const { data: existingRows, error: existingError } = await supabase
      .from("setlist_songs")
      .select("id")
      .eq("setlist_id", id);

    if (existingError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const { data: dupRow, error: dupError } = await supabase
      .from("setlist_songs")
      .select("id")
      .eq("setlist_id", id)
      .eq("song_id", parsed.songId)
      .maybeSingle();

    if (dupError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (dupRow) {
      return fail("That song is already in the setlist.", ErrorCode.CONFLICT, 409);
    }

    const nextPosition = (existingRows ?? []).length + 1;

    const payload = {
      setlist_id: id,
      song_id: parsed.songId,
      position: nextPosition,
      key_override: parsed.keyOverride ?? null,
    } as unknown as Database["public"]["Tables"]["setlist_songs"]["Insert"];

    const { error: insertError } = await supabase.from("setlist_songs").insert(payload);

    if (insertError) {
      // Race backstop: a Postgres unique-violation on (setlist_id, song_id)
      // means the song was added concurrently — same BR-07 conflict.
      if (insertError.code === "23505") {
        return fail("That song is already in the setlist.", ErrorCode.CONFLICT, 409);
      }
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const { data: songs, error } = await loadSongResponses(supabase, id);
    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ songs }, 201);
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/setlists/:id/publish — set_leader/admin only. draft -> published
// (BR-01: zero songs is a valid publishable state). Notifies confirmed
// members (accepted invitations for the parent service week). Re-notifying
// is done via unlock -> edit -> publish, so this only ever acts on a draft;
// an already-published setlist is a 409.
export async function publishSetlist(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data, error } = await supabase
      .from("setlists")
      .select("*")
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!data) {
      return fail("Setlist not found", ErrorCode.NOT_FOUND, 404);
    }
    if (data.status !== "draft") {
      return fail("Setlist is already published.", ErrorCode.CONFLICT, 409);
    }

    const { data: updated, error: updateError } = await supabase
      .from("setlists")
      .update({ status: "published", published_at: new Date().toISOString() })
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .select("*")
      .maybeSingle();

    if (updateError || !updated) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const { data: songRows, error: songsError } = await supabase
      .from("setlist_songs")
      .select("id")
      .eq("setlist_id", id);

    if (songsError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    const songCount = (songRows ?? []).length;

    const { data: invitations, error: invitationsError } = await supabase
      .from("invitations")
      .select("user_id")
      .eq("service_week_id", updated.service_week_id)
      .eq("status", "accepted");

    if (invitationsError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const recipientIds = [...new Set((invitations ?? []).map((i) => i.user_id))];

    if (recipientIds.length > 0) {
      const notificationInsertPayload = recipientIds.map((userId) => ({
        church_group_id: ctx.churchGroupId,
        user_id: userId,
        type: "setlist_released",
        title: "Setlist published",
        body:
          songCount === 0 ? "The setlist has been published — songs are still being added." : null,
        link_entity_type: "setlist",
        link_entity_id: id,
      })) as unknown as Database["public"]["Tables"]["notifications"]["Insert"][];

      const { error: notificationsError } = await supabase
        .from("notifications")
        .insert(notificationInsertPayload);

      if (notificationsError) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }

      // TODO(#67/#68): SMS/email fan-out for confirmed members.
    }

    return ok({ setlist: toSetlistResponse(updated) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/setlists/:id/unlock — set_leader/admin only. published -> draft
// so the setlist can be edited again. Sends no notifications and takes no
// request body — the next publish re-notifies confirmed members.
export async function unlockSetlist(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data, error } = await supabase
      .from("setlists")
      .select("*")
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!data) {
      return fail("Setlist not found", ErrorCode.NOT_FOUND, 404);
    }
    if (data.status !== "published") {
      return fail("Setlist is not published; nothing to unlock.", ErrorCode.CONFLICT, 409);
    }

    const { data: updated, error: updateError } = await supabase
      .from("setlists")
      .update({ status: "draft", published_at: null })
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .select("*")
      .maybeSingle();

    if (updateError || !updated) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ setlist: toSetlistResponse(updated) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// DELETE /api/setlists/:id/songs/:songId — set_leader/admin only. Removes a
// song from the setlist and recompacts the remaining positions to 1..N.
export async function removeSetlistSong(
  req: NextRequest,
  id: string,
  songId: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const editable = await loadEditableSetlist(supabase, id, ctx.churchGroupId);
    if (!editable.ok) {
      return editable.response;
    }

    const { data: deletedRows, error: deleteError } = await supabase
      .from("setlist_songs")
      .delete()
      .eq("setlist_id", id)
      .eq("song_id", songId)
      .select("id");

    if (deleteError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if ((deletedRows ?? []).length === 0) {
      return fail("Song not found in setlist", ErrorCode.NOT_FOUND, 404);
    }

    // Recompact positions: no (setlist_id, position) unique constraint
    // exists, so intermediate states during sequential updates cannot
    // collide.
    const { data: remainingRows, error: remainingError } = await supabase
      .from("setlist_songs")
      .select("id, position")
      .eq("setlist_id", id)
      .order("position", { ascending: true });

    if (remainingError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    for (let i = 0; i < (remainingRows ?? []).length; i++) {
      const row = remainingRows![i]!;
      if (row.position !== i + 1) {
        const { error: updateError } = await supabase
          .from("setlist_songs")
          .update({
            position: i + 1,
          } as unknown as Database["public"]["Tables"]["setlist_songs"]["Update"])
          .eq("id", row.id);

        if (updateError) {
          return fail("Internal error", ErrorCode.INTERNAL, 500);
        }
      }
    }

    const { data: songs, error } = await loadSongResponses(supabase, id);
    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ songs });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
