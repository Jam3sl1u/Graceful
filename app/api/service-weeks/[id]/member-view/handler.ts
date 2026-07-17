import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getDownloadUrl } from "@/lib/r2/client";
import type { EventType, InvitationStatus, VocalCapability } from "@/types/domain";

export type MemberWeekEvent = {
  id: string;
  type: EventType;
  name: string;
  location: string | null;
  startTime: string; // events.start_time
  endTime: string; // events.end_time
  notes: string | null;
  assigned: boolean; // caller is in event_attendees for this event
};

export type MemberWeekSong = {
  songId: string;
  title: string;
  artist: string | null;
  position: number; // setlist_songs.position
  effectiveKey: string | null; // key_override ?? songs.default_key
};

export type MemberWeekTeamMember = {
  userId: string;
  name: string;
  vocalCapability: VocalCapability; // 'none' when no member_profile
  instruments: { id: string; name: string }[];
};

export type MemberWeekDocumentGroup = {
  songId: string;
  songTitle: string;
  files: {
    id: string;
    name: string;
    fileType: string;
    fileSizeBytes: number;
    downloadUrl: string; // presigned GET, 30-min expiry
  }[];
};

export type MemberWeekViewResponse = {
  serviceWeek: {
    id: string;
    serviceDate: string; // service_weeks.service_date (YYYY-MM-DD)
    title: string | null;
    isCancelled: boolean;
  };
  confirmationStatus: InvitationStatus | null; // caller's own invitation status for this week; null if none
  setlist: { status: "published"; songs: MemberWeekSong[] } | null; // null = draft or no setlist
  events: MemberWeekEvent[]; // ALL events of the week (assigned flag per event), ordered by startTime asc
  team: MemberWeekTeamMember[];
  documents: MemberWeekDocumentGroup[];
};

// GET /api/service-weeks/:id/member-view — a single aggregate read for the
// Member Week View screen (#65). Admin/set_leader/member only (guest variant
// is #72, out of scope). All reads go through the caller's RLS-scoped
// Supabase client — no service-role usage, no new RPC.
export async function getMemberWeekView(
  req: NextRequest,
  id: string,
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

    // 1. Service week
    const { data: weekRow, error: weekError } = await supabase
      .from("service_weeks")
      .select("id, service_date, title, is_cancelled")
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (weekError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!weekRow) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    const serviceWeek = {
      id: weekRow.id,
      serviceDate: weekRow.service_date,
      title: weekRow.title,
      isCancelled: weekRow.is_cancelled,
    };

    // 2. Caller's own invitation (latest by created_at, re-invite safety)
    const { data: invitationRows, error: invitationError } = await supabase
      .from("invitations")
      .select("status, created_at")
      .eq("service_week_id", id)
      .eq("user_id", ctx.userId);

    if (invitationError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    let confirmationStatus: InvitationStatus | null = null;
    if (invitationRows && invitationRows.length > 0) {
      const latest = invitationRows.reduce((latest, row) =>
        row.created_at > latest.created_at ? row : latest,
      );
      confirmationStatus = latest.status;
    }

    // 4. Setlist (RLS filters drafts out for members; a returned row for a
    // member is always published, but check status explicitly regardless).
    const { data: setlistRow, error: setlistError } = await supabase
      .from("setlists")
      .select("id, status")
      .eq("service_week_id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (setlistError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    let setlist: MemberWeekViewResponse["setlist"] = null;
    const songTitleById = new Map<string, string>();
    let weekSongIds: string[] = [];

    if (setlistRow && setlistRow.status === "published") {
      const { data: setlistSongRows, error: setlistSongsError } = await supabase
        .from("setlist_songs")
        .select("song_id, position, key_override")
        .eq("setlist_id", setlistRow.id)
        .order("position", { ascending: true });

      if (setlistSongsError) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }

      const songIds = Array.from(new Set((setlistSongRows ?? []).map((r) => r.song_id)));
      weekSongIds = songIds;

      let songById = new Map<string, { title: string; artist: string | null; default_key: string | null }>();
      if (songIds.length > 0) {
        const { data: songRows, error: songsError } = await supabase
          .from("songs")
          .select("id, title, artist, default_key")
          .in("id", songIds);

        if (songsError) {
          return fail("Internal error", ErrorCode.INTERNAL, 500);
        }

        songById = new Map((songRows ?? []).map((s) => [s.id, s]));
        for (const s of songRows ?? []) {
          songTitleById.set(s.id, s.title);
        }
      }

      const songs: MemberWeekSong[] = (setlistSongRows ?? []).map((row) => {
        const song = songById.get(row.song_id);
        return {
          songId: row.song_id,
          title: song?.title ?? "",
          artist: song?.artist ?? null,
          position: row.position,
          effectiveKey: row.key_override ?? song?.default_key ?? null,
        };
      });

      setlist = { status: "published", songs };
    }

    // 5. Events
    const { data: eventRows, error: eventsError } = await supabase
      .from("events")
      .select("id, type, name, location, start_time, end_time, notes")
      .eq("service_week_id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .order("start_time", { ascending: true });

    if (eventsError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const weekEventIds = (eventRows ?? []).map((e) => e.id);

    // 6. Attendees (guard against an empty id list — skip the query).
    let attendeeRows: { event_id: string; user_id: string }[] = [];
    if (weekEventIds.length > 0) {
      const { data, error: attendeesError } = await supabase
        .from("event_attendees")
        .select("event_id, user_id")
        .in("event_id", weekEventIds);

      if (attendeesError) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }
      attendeeRows = data ?? [];
    }

    const events: MemberWeekEvent[] = (eventRows ?? []).map((e) => ({
      id: e.id,
      type: e.type,
      name: e.name,
      location: e.location,
      startTime: e.start_time,
      endTime: e.end_time,
      notes: e.notes,
      assigned: attendeeRows.some((a) => a.event_id === e.id && a.user_id === ctx.userId),
    }));

    const teamUserIds = Array.from(new Set(attendeeRows.map((a) => a.user_id)));

    // 7. Team directory (only if teamUserIds non-empty)
    let team: MemberWeekTeamMember[] = [];
    if (teamUserIds.length > 0) {
      const [usersRes, profilesRes, miRes, instrRes] = await Promise.all([
        supabase
          .from("users")
          .select("id, name")
          .eq("church_group_id", ctx.churchGroupId)
          .is("anonymized_at", null)
          .in("id", teamUserIds),
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
        if (!name) continue;
        const existing = instrumentsByProfileId.get(mi.member_profile_id) ?? [];
        existing.push({ id: mi.instrument_id, name });
        instrumentsByProfileId.set(mi.member_profile_id, existing);
      }

      team = (usersRes.data ?? [])
        .map((user) => {
          const profile = profileByUserId.get(user.id);
          return {
            userId: user.id,
            name: user.name,
            vocalCapability: profile ? profile.vocalCapability : "none",
            instruments: profile ? (instrumentsByProfileId.get(profile.profileId) ?? []) : [],
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    // 8. Documents (best-effort — never 500 the whole screen for R2/query
    // failures; documents are one non-critical section).
    let documents: MemberWeekDocumentGroup[] = [];
    if (setlist && weekSongIds.length > 0) {
      try {
        const { data: docRows, error: docsError } = await supabase
          .from("song_documents")
          .select("id, song_id, name, file_key, file_type, file_size_bytes")
          .in("song_id", weekSongIds)
          .eq("church_group_id", ctx.churchGroupId)
          .order("created_at", { ascending: true });

        if (docsError) throw docsError;

        const groupsBySongId = new Map<string, MemberWeekDocumentGroup>();
        for (const row of docRows ?? []) {
          const downloadUrl = await getDownloadUrl(row.file_key);
          const group = groupsBySongId.get(row.song_id) ?? {
            songId: row.song_id,
            songTitle: songTitleById.get(row.song_id) ?? "",
            files: [],
          };
          group.files.push({
            id: row.id,
            name: row.name,
            fileType: row.file_type,
            fileSizeBytes: row.file_size_bytes,
            downloadUrl,
          });
          groupsBySongId.set(row.song_id, group);
        }

        documents = Array.from(groupsBySongId.values()).filter((g) => g.files.length > 0);
      } catch {
        documents = [];
      }
    }

    return ok<MemberWeekViewResponse>({
      serviceWeek,
      confirmationStatus,
      setlist,
      events,
      team,
      documents,
    });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
