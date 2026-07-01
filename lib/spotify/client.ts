import "server-only";

// TODO(Sprint 3 #44): client-credentials token fetch + read-only track
// metadata lookup (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET). Metadata only
// — Spotify never provides audio (PRD §19.1).
export async function lookupTrack(
  _query: string,
): Promise<{ title: string; artist: string; bpm?: number } | null> {
  throw new Error("lookupTrack not implemented — see Sprint 3 #44");
}
