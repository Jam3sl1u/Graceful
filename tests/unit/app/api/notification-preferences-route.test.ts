jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  type NotificationPreferencesResponse,
} from "@/app/api/notifications/preferences/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";

function makeReq(body?: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeLookup(): UserLookup {
  const ctx: AuthContext = {
    userId: USER_ID,
    churchGroupId: CHURCH_GROUP_ID,
    role: "member",
  };
  return async () => ctx;
}

function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

// Matches the PRD §6.9.1 defaults (also asserted against
// NOTIFICATION_PREFERENCE_DEFAULTS via the handler's own no-row branch).
const defaultsRow = {
  invitation_sms: true,
  invitation_email: true,
  invitation_inapp: true,
  reminder_sms: true,
  reminder_email: false,
  reminder_hours_before: 24,
  setlist_sms: true,
  setlist_email: true,
  gcal_sync_enabled: false,
};

// upsertResult, when present, is what the post-upsert `.select().maybeSingle()`
// resolves to (simulating the DB echoing back the row the upsert wrote).
// It defaults to `data` — sufficient whenever the pre-upsert select fixture
// already represents an existing row.
type QueryResult = { data: unknown; error: unknown; upsertResult?: unknown };

function makeSupabaseClient(
  overrides: Partial<Record<string, QueryResult>> = {},
  onUpsert?: (table: string, payload: unknown, opts: unknown) => void,
) {
  const fixtures: Record<string, QueryResult> = {
    notification_preferences: { data: defaultsRow, error: null },
    ...overrides,
  };

  return {
    from: jest.fn((table: string) => ({
      select: jest.fn(() => {
        const result = fixtures[table];
        const chain = Promise.resolve(result) as Promise<QueryResult> & {
          eq: jest.Mock;
        };
        chain.eq = jest.fn(() => {
          const eqChain = Promise.resolve(result) as Promise<QueryResult> & {
            maybeSingle: jest.Mock;
          };
          eqChain.maybeSingle = jest.fn(() => Promise.resolve(result));
          return eqChain;
        });
        return chain;
      }),
      upsert: jest.fn((payload: unknown, opts: unknown) => {
        onUpsert?.(table, payload, opts);
        const result = fixtures[table];
        const upsertData = result && "upsertResult" in result ? result.upsertResult : result?.data;
        return {
          select: jest.fn(() => ({
            maybeSingle: jest.fn(() =>
              Promise.resolve({ data: upsertData, error: result?.error ?? null }),
            ),
          })),
        };
      }),
    })),
  };
}

describe("GET /api/notifications/preferences", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await getNotificationPreferences(makeReq(), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT (no Supabase client built)", async () => {
    setUpAuth(null);

    const res = await getNotificationPreferences(makeReq(), makeLookup());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 200 with an existing row, snake_case mapped to camelCase", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        notification_preferences: {
          data: { ...defaultsRow, reminder_email: true, gcal_sync_enabled: true },
          error: null,
        },
      }),
    );

    const res = await getNotificationPreferences(makeReq(), makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    const preferences: NotificationPreferencesResponse = body.data.preferences;
    expect(preferences).toEqual({
      userId: USER_ID,
      invitationSms: true,
      invitationEmail: true,
      invitationInapp: true,
      reminderSms: true,
      reminderEmail: true,
      reminderHoursBefore: 24,
      setlistSms: true,
      setlistEmail: true,
      gcalSyncEnabled: true,
    });
  });

  it("returns 200 with PRD defaults when no row exists, and never upserts", async () => {
    setUpAuth();
    let upsertCalled = false;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        { notification_preferences: { data: null, error: null } },
        () => {
          upsertCalled = true;
        },
      ),
    );

    const res = await getNotificationPreferences(makeReq(), makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    const preferences: NotificationPreferencesResponse = body.data.preferences;
    expect(preferences).toEqual({
      userId: USER_ID,
      invitationSms: true,
      invitationEmail: true,
      invitationInapp: true,
      reminderSms: true,
      reminderEmail: false,
      reminderHoursBefore: 24,
      setlistSms: true,
      setlistEmail: true,
      gcalSyncEnabled: false,
    });
    expect(upsertCalled).toBe(false);
  });

  it("returns 500 INTERNAL when the select query returns an error", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        notification_preferences: { data: null, error: { message: "connection refused" } },
      }),
    );

    const res = await getNotificationPreferences(makeReq(), makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("PUT /api/notifications/preferences", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
  });

  it("returns 200 and upserts the merged row on a happy-path partial update", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    let capturedOpts: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        {
          notification_preferences: {
            data: { ...defaultsRow, reminder_email: true },
            error: null,
          },
        },
        (table, payload, opts) => {
          if (table === "notification_preferences") {
            capturedPayload = payload;
            capturedOpts = opts;
          }
        },
      ),
    );

    const res = await updateNotificationPreferences(makeReq({ reminderEmail: true }), makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    const preferences: NotificationPreferencesResponse = body.data.preferences;
    expect(preferences.reminderEmail).toBe(true);
    expect(capturedPayload).toEqual({
      user_id: USER_ID,
      invitation_sms: true,
      invitation_email: true,
      invitation_inapp: true,
      reminder_sms: true,
      reminder_email: true,
      reminder_hours_before: 24,
      setlist_sms: true,
      setlist_email: true,
      gcal_sync_enabled: false,
    });
    expect(capturedOpts).toEqual({ onConflict: "user_id" });
  });

  it("returns 200 unchanged for an empty object body ({})", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateNotificationPreferences(makeReq({}), makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    const preferences: NotificationPreferencesResponse = body.data.preferences;
    expect(preferences).toEqual({
      userId: USER_ID,
      invitationSms: true,
      invitationEmail: true,
      invitationInapp: true,
      reminderSms: true,
      reminderEmail: false,
      reminderHoursBefore: 24,
      setlistSms: true,
      setlistEmail: true,
      gcalSyncEnabled: false,
    });
  });

  it("merges onto PRD defaults and inserts via upsert when no row exists yet", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        {
          notification_preferences: {
            data: null,
            error: null,
            upsertResult: { ...defaultsRow, gcal_sync_enabled: true },
          },
        },
        (table, payload) => {
          if (table === "notification_preferences") capturedPayload = payload;
        },
      ),
    );

    const res = await updateNotificationPreferences(
      makeReq({ gcalSyncEnabled: true }),
      makeLookup(),
    );
    expect(res.status).toBe(200);
    expect(capturedPayload).toEqual({
      user_id: USER_ID,
      invitation_sms: true,
      invitation_email: true,
      invitation_inapp: true,
      reminder_sms: true,
      reminder_email: false,
      reminder_hours_before: 24,
      setlist_sms: true,
      setlist_email: true,
      gcal_sync_enabled: true,
    });
  });

  it("returns 422 VALIDATION_FAILED (BR-14) when a body disables all three invitation channels directly, and issues no upsert", async () => {
    setUpAuth();
    let upsertCalled = false;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({}, () => {
        upsertCalled = true;
      }),
    );

    const res = await updateNotificationPreferences(
      makeReq({ invitationSms: false, invitationEmail: false, invitationInapp: false }),
      makeLookup(),
    );
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(upsertCalled).toBe(false);
  });

  it("returns 422 VALIDATION_FAILED (BR-14) when the merge disables the last remaining invitation channel", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        notification_preferences: {
          data: { ...defaultsRow, invitation_sms: false, invitation_email: false },
          error: null,
        },
      }),
    );

    const res = await updateNotificationPreferences(
      makeReq({ invitationInapp: false }),
      makeLookup(),
    );
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 200 when the merge still leaves one invitation channel enabled", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        notification_preferences: {
          data: { ...defaultsRow, invitation_sms: false, invitation_email: false },
          error: null,
        },
      }),
    );

    const res = await updateNotificationPreferences(makeReq({ invitationInapp: true }), makeLookup());
    expect(res.status).toBe(200);
  });

  it("allows re-enabling a previously disabled invitation channel", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        notification_preferences: {
          data: {
            ...defaultsRow,
            invitation_sms: false,
            invitation_email: false,
            invitation_inapp: false,
          },
          error: null,
        },
      }),
    );

    const res = await updateNotificationPreferences(makeReq({ invitationSms: true }), makeLookup());
    expect(res.status).toBe(200);
  });

  it("returns 400 VALIDATION_FAILED for a malformed body (null)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateNotificationPreferences(makeReq(null), makeLookup());
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a malformed body (array)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateNotificationPreferences(makeReq([1, 2, 3]), makeLookup());
    expect(res.status).toBe(400);
  });

  it("returns 400 VALIDATION_FAILED for wrong field types", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateNotificationPreferences(
      makeReq({ invitationSms: "yes" }),
      makeLookup(),
    );
    expect(res.status).toBe(400);
  });

  it.each([0, 169, 1.5])(
    "returns 400 VALIDATION_FAILED for an out-of-range reminderHoursBefore (%p)",
    async (value) => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

      const res = await updateNotificationPreferences(
        makeReq({ reminderHoursBefore: value }),
        makeLookup(),
      );
      expect(res.status).toBe(400);
    },
  );

  it("returns 400 VALIDATION_FAILED when reminderHoursBefore is a string", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateNotificationPreferences(
      makeReq({ reminderHoursBefore: "24" }),
      makeLookup(),
    );
    expect(res.status).toBe(400);
  });

  it("strips unknown keys (e.g. userId, chatPreference) and never writes them", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({}, (table, payload) => {
        if (table === "notification_preferences") capturedPayload = payload;
      }),
    );

    const res = await updateNotificationPreferences(
      makeReq({ userId: "someone-elses-id", chatPreference: "all", id: "row-x" }),
      makeLookup(),
    );
    expect(res.status).toBe(200);
    expect(capturedPayload).toMatchObject({ user_id: USER_ID });
    expect(capturedPayload).not.toHaveProperty("id");
    expect(capturedPayload).not.toHaveProperty("chat_preference");
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT (no Supabase client built)", async () => {
    setUpAuth(null);

    const res = await updateNotificationPreferences(makeReq({}), makeLookup());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the select query returns an error", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        notification_preferences: { data: null, error: { message: "connection refused" } },
      }),
    );

    const res = await updateNotificationPreferences(makeReq({}), makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
