jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { setSongFamiliarity } from "@/app/api/songs/[id]/familiarity/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const SONG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "user-1";
const GROUP_ID = "group-1";

const req = (body: unknown): NextRequest =>
  ({ json: jest.fn().mockResolvedValue(body) }) as unknown as NextRequest;

const lookup = (role: UserRole): UserLookup => async () =>
  ({ userId: USER_ID, churchGroupId: GROUP_ID, role }) as AuthContext;

function makeClient(opts: {
  song?: { data: unknown; error: unknown };
  upsert?: { data: unknown; error: unknown };
}) {
  const song = opts.song ?? { data: { id: SONG_ID }, error: null };
  const upsert = opts.upsert ?? {
    data: { song_id: SONG_ID, level: "learning" },
    error: null,
  };
  const upsertFn = jest.fn(() => ({
    select: () => ({ single: () => Promise.resolve(upsert) }),
  }));
  const client = {
    from: jest.fn((table: string) => {
      if (table === "songs") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve(song),
        };
        return chain;
      }
      return { upsert: upsertFn };
    }),
  };
  return { client, upsertFn };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockAuth.mockResolvedValue({ userId: "clerk_test", getToken: jest.fn().mockResolvedValue("jwt") });
});

describe("PUT /api/songs/:id/familiarity", () => {
  it.each(["comfortable", "learning", "not_learned"])(
    "stores %s for the caller's own row and returns it",
    async (level) => {
      const { client, upsertFn } = makeClient({
        upsert: { data: { song_id: SONG_ID, level }, error: null },
      });
      mockGetSupabaseClient.mockReturnValue(client);

      const res = await setSongFamiliarity(req({ level }), SONG_ID, lookup("member"));
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual({ songId: SONG_ID, level });

      const [payload, options] = upsertFn.mock.calls[0] as unknown as [
        Record<string, unknown>,
        { onConflict: string },
      ];
      expect(payload).toMatchObject({
        church_group_id: GROUP_ID,
        user_id: USER_ID,
        song_id: SONG_ID,
        level,
      });
      expect(options).toEqual({ onConflict: "user_id,song_id" });
    },
  );

  it.each<UserRole>(["admin", "set_leader"])("allows %s", async (role) => {
    mockGetSupabaseClient.mockReturnValue(makeClient({}).client);
    const res = await setSongFamiliarity(req({ level: "learning" }), SONG_ID, lookup(role));
    expect(res.status).toBe(200);
  });

  it("rejects guests with 403 before touching the database", async () => {
    const res = await setSongFamiliarity(req({ level: "learning" }), SONG_ID, lookup("guest"));
    expect(res.status).toBe(403);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown level", { level: "expert" }],
    ["a missing level", {}],
    ["a non-object body", "learning"],
    ["a null body", null],
  ])("returns 400 for %s", async (_label, body) => {
    const res = await setSongFamiliarity(req(body), SONG_ID, lookup("member"));
    expect(res.status).toBe(400);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed song id", async () => {
    const res = await setSongFamiliarity(req({ level: "learning" }), "not-a-uuid", lookup("member"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the song is not in the caller's group", async () => {
    const { client, upsertFn } = makeClient({ song: { data: null, error: null } });
    mockGetSupabaseClient.mockReturnValue(client);
    const res = await setSongFamiliarity(req({ level: "learning" }), SONG_ID, lookup("member"));
    expect(res.status).toBe(404);
    expect(upsertFn).not.toHaveBeenCalled();
  });

  it("returns 500 when the upsert fails", async () => {
    mockGetSupabaseClient.mockReturnValue(
      makeClient({ upsert: { data: null, error: { message: "boom" } } }).client,
    );
    const res = await setSongFamiliarity(req({ level: "learning" }), SONG_ID, lookup("member"));
    expect(res.status).toBe(500);
  });

  it("returns 401 when there is no Supabase token", async () => {
    mockAuth.mockResolvedValue({ userId: "clerk_test", getToken: jest.fn().mockResolvedValue(null) });
    const res = await setSongFamiliarity(req({ level: "learning" }), SONG_ID, lookup("member"));
    expect(res.status).toBe(401);
  });
});
