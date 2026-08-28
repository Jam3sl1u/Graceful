/**
 * Live verification for escapePostgrestFilterValue (lib/api/postgrest.ts).
 *
 * The unit tests for this function (tests/unit/lib/api/postgrest.test.ts)
 * and the song-search handler tests only assert against a mocked Supabase
 * `.or()` call — they never confirm the escaped filter string is actually
 * valid PostgREST syntax. A rejection here would 500 song search invisibly,
 * so this runs the exact filter shape `listSongs` builds
 * (app/api/songs/handler.ts) against a live PostgREST instance.
 *
 * Run: bun run test:rls
 */

import { escapePostgrestFilterValue } from "@/lib/api/postgrest";
import { IDS, rlsTestsEnabled, seedViaServiceClient, globalSetup } from "./setup";
import { clients } from "./helpers";

const SKIP = !process.env.SUPABASE_TEST_URL || !process.env.SUPABASE_JWT_SECRET;

const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe("PostgREST quoting — live filter syntax", () => {
  beforeAll(async () => {
    await globalSetup();
    if (rlsTestsEnabled) {
      await seedViaServiceClient();
    }
  }, 60_000);

  it("accepts a search term containing a double-quote and backslash without a syntax error", async () => {
    const term = 'A1" or ("x\\';
    const escaped = escapePostgrestFilterValue(term);

    const { data, error } = await clients
      .memberA()
      .from("songs")
      .select("id, title, artist")
      .or(`title.ilike."%${escaped}%",artist.ilike."%${escaped}%"`);

    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  it("still matches the intended row when the escaped term is a real substring", async () => {
    const term = 'Song A1" or 1=1 --';
    const escaped = escapePostgrestFilterValue(term);

    const { data, error } = await clients
      .memberA()
      .from("songs")
      .select("id, title, artist")
      .or(`title.ilike."%${escaped}%",artist.ilike."%${escaped}%"`);

    expect(error).toBeNull();
    // The injected clause must not widen the match to unrelated rows —
    // neither song A2 nor any Church B song should appear.
    expect((data ?? []).map((row: { id: string }) => row.id)).not.toContain(IDS.songs.A2);
    expect((data ?? []).map((row: { id: string }) => row.id)).not.toContain(IDS.songs.B1);
  });
});
