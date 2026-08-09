// Injection / malformed-input test suite (issue #80, AC-3). Directory
// precedent: tests/unit/schemas/events.test.ts.
//
// Part A sweeps every genuinely free-text string field of every exported Zod
// object schema in schemas/*.ts against a shared adversarial payload corpus.
// Part B extends the existing lib/api/postgrest.ts corpus
// (tests/unit/lib/api/postgrest.test.ts) with the same payloads. Part C
// covers the two places user input is interpolated into a PostgREST filter
// string at the handler level.

import { escapePostgrestFilterValue } from "@/lib/api/postgrest";
import { createChurchGroupSchema, joinChurchGroupSchema } from "@/schemas/church-group";
import { createEventSchema } from "@/schemas/events";
import { googleCalendarCallbackQuerySchema } from "@/schemas/google-calendar";
import { createInstrumentSchema } from "@/schemas/instruments";
import {
  createInvitationSchema,
  createGuestInvitationSchema,
  denyInvitationSchema,
} from "@/schemas/invitations";
import { updateProfileSchema, VOCAL_CAPABILITY_VALUES } from "@/schemas/profile";
import { updateRoleSchema, USER_ROLE_VALUES } from "@/schemas/role";
import { createServiceWeekSchema } from "@/schemas/service-weeks";
import { addSetlistSongSchema } from "@/schemas/setlists";
import { uploadUrlSchema, registerDocumentSchema } from "@/schemas/song-documents";
import { createSongSchema, songSearchQuerySchema, isValidSongKey } from "@/schemas/songs";
import {
  getAvailabilityQuerySchema,
  getTeamAvailabilityQuerySchema,
  setAvailabilityEntrySchema,
} from "@/schemas/availability";

// ---------------------------------------------------------------------------
// Shared adversarial payload corpus. Never paste a raw non-printable, bidi,
// or astral character into this file — build them with String.fromCharCode /
// String.fromCodePoint so the file stays plain text to git/grep.
// ---------------------------------------------------------------------------

const NUL = String.fromCharCode(0x0000); // null byte
const RTL = String.fromCharCode(0x202e); // right-to-left override
const BOM = String.fromCharCode(0xfeff); // byte-order mark
const IDSP = String.fromCharCode(0x3000); // ideographic space
const LONE = String.fromCharCode(0xd800); // lone surrogate
const ACUTE = String.fromCharCode(0x0301); // combining acute accent
const ASTRAL = String.fromCodePoint(0x1d518); // astral-plane letter

const SQLI = [
  "'; DROP TABLE users; --",
  "' OR '1'='1",
  "1; SELECT pg_sleep(10)--",
  '" OR ""="',
  "admin'--",
];

const XSS = [
  "<script>alert(1)</script>",
  "javascript:alert(1)",
  "<img src=x onerror=alert(1)>",
  '"><svg/onload=alert(1)>',
  "&lt;script&gt;alert(1)&lt;/script&gt;",
];

// Null bytes: leading, embedded, trailing.
const NULL_BYTES = [NUL + "lead", "ok" + NUL + "injected", "trail" + NUL];

const UNICODE = [
  RTL + "gnp.exe",
  ASTRAL + ASTRAL,
  "e" + ACUTE, // combining form
  "é", // precomposed form: same glyph, different bytes
  BOM + "bom",
  IDSP,
  LONE,
];

const ALL_PAYLOADS = [...SQLI, ...XSS, ...NULL_BYTES, ...UNICODE];

// ---------------------------------------------------------------------------
// Part A — schema sweep
// ---------------------------------------------------------------------------

const R1 = "22222222-2222-2222-2222-222222222222";
const R2 = "33333333-3333-3333-3333-333333333333";

type FieldCase = {
  label: string;
  schema: { safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> } };
  field: string;
  baseValid: () => Record<string, unknown>;
  max?: number;
  trims: boolean;
  min1?: boolean;
  transform?: (trimmed: string) => string;
  emptyBecomesNull?: boolean;
};

const FIELD_CASES: FieldCase[] = [
  // schemas/church-group.ts
  {
    label: "createChurchGroupSchema",
    schema: createChurchGroupSchema,
    field: "name",
    baseValid: () => ({ name: "Test Church", timezone: "America/Chicago" }),
    max: 100,
    trims: true,
    min1: true,
  },
  {
    label: "createChurchGroupSchema",
    schema: createChurchGroupSchema,
    field: "timezone",
    baseValid: () => ({ name: "Test Church", timezone: "America/Chicago" }),
    max: 50,
    trims: true,
    min1: true,
  },
  {
    label: "createChurchGroupSchema",
    schema: createChurchGroupSchema,
    field: "denomination",
    baseValid: () => ({ name: "Test Church", timezone: "America/Chicago" }),
    max: 100,
    trims: true,
  },
  {
    label: "createChurchGroupSchema",
    schema: createChurchGroupSchema,
    field: "logoUrl",
    baseValid: () => ({ name: "Test Church", timezone: "America/Chicago" }),
    max: 2048,
    trims: true,
  },
  {
    label: "joinChurchGroupSchema",
    schema: joinChurchGroupSchema,
    field: "inviteCode",
    baseValid: () => ({ inviteCode: "ABCDEF12" }),
    max: 20,
    trims: true,
    min1: true,
    // .trim().toUpperCase() — the parsed value is the trimmed value
    // uppercased, not the raw payload.
    transform: (trimmed) => trimmed.toUpperCase(),
  },
  // schemas/events.ts
  {
    label: "createEventSchema",
    schema: createEventSchema,
    field: "name",
    baseValid: () => ({
      serviceWeekId: R1,
      type: "rehearsal",
      name: "Event",
      startTime: "2026-01-01T00:00:00.000Z",
      endTime: "2026-01-01T01:00:00.000Z",
    }),
    max: 100,
    trims: true,
    min1: true,
  },
  {
    label: "createEventSchema",
    schema: createEventSchema,
    field: "location",
    baseValid: () => ({
      serviceWeekId: R1,
      type: "rehearsal",
      name: "Event",
      startTime: "2026-01-01T00:00:00.000Z",
      endTime: "2026-01-01T01:00:00.000Z",
    }),
    max: 200,
    trims: true,
    min1: true,
  },
  {
    label: "createEventSchema",
    schema: createEventSchema,
    field: "notes",
    baseValid: () => ({
      serviceWeekId: R1,
      type: "rehearsal",
      name: "Event",
      startTime: "2026-01-01T00:00:00.000Z",
      endTime: "2026-01-01T01:00:00.000Z",
    }),
    max: 2000,
    trims: true,
    min1: true,
  },
  // schemas/google-calendar.ts — provider-supplied opaque strings, bounded
  // by length only (no .trim()).
  {
    label: "googleCalendarCallbackQuerySchema",
    schema: googleCalendarCallbackQuerySchema,
    field: "code",
    baseValid: () => ({}),
    max: 2048,
    trims: false,
    min1: true,
  },
  {
    label: "googleCalendarCallbackQuerySchema",
    schema: googleCalendarCallbackQuerySchema,
    field: "state",
    baseValid: () => ({}),
    max: 512,
    trims: false,
    min1: true,
  },
  {
    label: "googleCalendarCallbackQuerySchema",
    schema: googleCalendarCallbackQuerySchema,
    field: "error",
    baseValid: () => ({}),
    max: 200,
    trims: false,
    min1: true,
  },
  // schemas/instruments.ts
  {
    label: "createInstrumentSchema",
    schema: createInstrumentSchema,
    field: "name",
    baseValid: () => ({ name: "Piano" }),
    max: 100,
    trims: true,
    min1: true,
  },
  // schemas/invitations.ts
  {
    label: "createInvitationSchema",
    schema: createInvitationSchema,
    field: "roleNote",
    baseValid: () => ({ serviceWeekId: R1, userId: R2 }),
    max: 500,
    trims: true,
    min1: true,
  },
  {
    label: "createGuestInvitationSchema",
    schema: createGuestInvitationSchema,
    field: "name",
    baseValid: () => ({ serviceWeekId: R1, email: "guest@example.com" }),
    max: 100,
    trims: true,
    min1: true,
  },
  {
    label: "createGuestInvitationSchema",
    schema: createGuestInvitationSchema,
    field: "roleNote",
    baseValid: () => ({ serviceWeekId: R1, email: "guest@example.com" }),
    max: 500,
    trims: true,
    min1: true,
  },
  {
    label: "createGuestInvitationSchema",
    schema: createGuestInvitationSchema,
    field: "email",
    baseValid: () => ({ serviceWeekId: R1, email: "guest@example.com" }),
    max: 255,
    trims: true,
  },
  {
    label: "denyInvitationSchema",
    schema: denyInvitationSchema,
    field: "reason",
    baseValid: () => ({}),
    max: 200,
    trims: true,
  },
  // schemas/profile.ts — bio maps empty/whitespace-only to null (a
  // documented transform, not a sanitization failure — edge case #5).
  {
    label: "updateProfileSchema",
    schema: updateProfileSchema,
    field: "bio",
    baseValid: () => ({ vocalCapability: "lead", bio: "hello" }),
    max: 2000,
    trims: true,
    emptyBecomesNull: true,
  },
  // schemas/service-weeks.ts
  {
    label: "createServiceWeekSchema",
    schema: createServiceWeekSchema,
    field: "title",
    baseValid: () => ({
      serviceDate: "2026-01-01",
      title: "T",
      sermonTopic: "Topic",
      sermonScripture: "Scripture",
      speakerName: "Speaker",
    }),
    max: 100,
    trims: true,
    min1: true,
  },
  {
    label: "createServiceWeekSchema",
    schema: createServiceWeekSchema,
    field: "sermonTopic",
    baseValid: () => ({
      serviceDate: "2026-01-01",
      title: "T",
      sermonTopic: "Topic",
      sermonScripture: "Scripture",
      speakerName: "Speaker",
    }),
    max: 200,
    trims: true,
    min1: true,
  },
  {
    label: "createServiceWeekSchema",
    schema: createServiceWeekSchema,
    field: "sermonScripture",
    baseValid: () => ({
      serviceDate: "2026-01-01",
      title: "T",
      sermonTopic: "Topic",
      sermonScripture: "Scripture",
      speakerName: "Speaker",
    }),
    max: 200,
    trims: true,
    min1: true,
  },
  {
    label: "createServiceWeekSchema",
    schema: createServiceWeekSchema,
    field: "speakerName",
    baseValid: () => ({
      serviceDate: "2026-01-01",
      title: "T",
      sermonTopic: "Topic",
      sermonScripture: "Scripture",
      speakerName: "Speaker",
    }),
    max: 100,
    trims: true,
    min1: true,
  },
  // schemas/setlists.ts
  {
    label: "addSetlistSongSchema",
    schema: addSetlistSongSchema,
    field: "keyOverride",
    baseValid: () => ({ songId: R2 }),
    max: 5,
    trims: true,
    min1: true,
  },
  // schemas/song-documents.ts
  {
    label: "uploadUrlSchema",
    schema: uploadUrlSchema,
    field: "name",
    baseValid: () => ({ name: "chart.pdf", file_type: "application/pdf", file_size_bytes: 1000 }),
    max: 200,
    trims: true,
    min1: true,
  },
  {
    label: "uploadUrlSchema",
    schema: uploadUrlSchema,
    field: "file_type",
    baseValid: () => ({ name: "chart.pdf", file_type: "application/pdf", file_size_bytes: 1000 }),
    max: 50,
    trims: true,
    min1: true,
  },
  {
    label: "registerDocumentSchema",
    schema: registerDocumentSchema,
    field: "file_key",
    baseValid: () => ({
      name: "chart.pdf",
      file_type: "application/pdf",
      file_size_bytes: 1000,
      file_key: "song-documents/g/s/chart.pdf",
    }),
    max: 1024,
    trims: true,
    min1: true,
  },
  // schemas/songs.ts
  {
    label: "createSongSchema",
    schema: createSongSchema,
    field: "title",
    baseValid: () => ({ title: "Song" }),
    max: 200,
    trims: true,
    min1: true,
  },
  {
    label: "createSongSchema",
    schema: createSongSchema,
    field: "artist",
    baseValid: () => ({ title: "Song" }),
    max: 200,
    trims: true,
    min1: true,
  },
  {
    label: "createSongSchema",
    schema: createSongSchema,
    field: "default_key",
    baseValid: () => ({ title: "Song" }),
    max: 5,
    trims: true,
    min1: true,
  },
  {
    label: "songSearchQuerySchema",
    schema: songSearchQuerySchema,
    field: "q",
    baseValid: () => ({}),
    max: 200,
    trims: true,
  },
  // schemas/availability.ts
  {
    label: "getAvailabilityQuerySchema",
    schema: getAvailabilityQuerySchema,
    field: "user_id",
    baseValid: () => ({}),
    trims: false,
  },
  {
    label: "getTeamAvailabilityQuerySchema",
    schema: getTeamAvailabilityQuerySchema,
    field: "startDate",
    baseValid: () => ({ startDate: "2026-01-01", endDate: "2026-01-02" }),
    trims: false,
  },
  {
    label: "getTeamAvailabilityQuerySchema",
    schema: getTeamAvailabilityQuerySchema,
    field: "endDate",
    baseValid: () => ({ startDate: "2026-01-01", endDate: "2026-01-02" }),
    trims: false,
  },
  {
    label: "setAvailabilityEntrySchema",
    schema: setAvailabilityEntrySchema,
    field: "date",
    baseValid: () => ({ date: "2026-01-01", isAvailable: true }),
    trims: false,
  },
  {
    label: "setAvailabilityEntrySchema",
    schema: setAvailabilityEntrySchema,
    field: "note",
    baseValid: () => ({ date: "2026-01-01", isAvailable: true }),
    max: 500,
    trims: true,
    emptyBecomesNull: true,
  },
];

// Named assertion helper so a failure message identifies the schema, field,
// and payload — not just a bare toBe() mismatch.
function expectRejectedOrVerbatim(fc: FieldCase, payload: string): void {
  const input = { ...fc.baseValid(), [fc.field]: payload };
  const result = fc.schema.safeParse(input);

  if (!result.success || result.data === undefined) {
    return; // rejected — always an acceptable outcome
  }

  const data = result.data;
  const trimmed = fc.trims ? payload.trim() : payload;

  if (fc.emptyBecomesNull && trimmed.length === 0) {
    if (data[fc.field] !== null) {
      throw new Error(
        `[${fc.label}.${fc.field}] payload ${JSON.stringify(payload)} trimmed to empty but did not ` +
          `become null (documented transform) — got ${JSON.stringify(data[fc.field])}`,
      );
    }
    return;
  }

  const expected = fc.transform ? fc.transform(trimmed) : trimmed;
  if (data[fc.field] !== expected) {
    throw new Error(
      `[${fc.label}.${fc.field}] payload ${JSON.stringify(payload)} succeeded but was not preserved ` +
        `verbatim — expected ${JSON.stringify(expected)}, got ${JSON.stringify(data[fc.field])}`,
    );
  }
}

describe("schema injection sweep (Part A) — safeParse fails, or the value survives byte-for-byte", () => {
  for (const fc of FIELD_CASES) {
    describe(`${fc.label}.${fc.field}`, () => {
      it.each(ALL_PAYLOADS)("rejects or preserves verbatim: %j", (payload) => {
        expectRejectedOrVerbatim(fc, payload);
      });

      if (fc.max !== undefined) {
        const max = fc.max;
        it(`rejects oversized input (> ${max} chars)`, () => {
          const input = { ...fc.baseValid(), [fc.field]: "a".repeat(max + 1) };
          expect(fc.schema.safeParse(input).success).toBe(false);
        });
      }

      if (fc.trims && fc.min1) {
        it("rejects empty/whitespace-only input", () => {
          const input = { ...fc.baseValid(), [fc.field]: "   " };
          expect(fc.schema.safeParse(input).success).toBe(false);
        });
      }
    });
  }
});

describe("enum-typed fields reject every adversarial payload", () => {
  it.each(ALL_PAYLOADS)("updateProfileSchema.vocalCapability rejects %j", (payload) => {
    expect(VOCAL_CAPABILITY_VALUES as readonly string[]).not.toContain(payload);
    const result = updateProfileSchema.safeParse({ vocalCapability: payload, bio: null });
    expect(result.success).toBe(false);
  });

  it.each(ALL_PAYLOADS)("updateRoleSchema.role rejects %j", (payload) => {
    expect(USER_ROLE_VALUES as readonly string[]).not.toContain(payload);
    const result = updateRoleSchema.safeParse({ role: payload });
    expect(result.success).toBe(false);
  });

  it.each(ALL_PAYLOADS)("isValidSongKey rejects %j", (payload) => {
    expect(isValidSongKey(payload)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part B — filter-escaping (escapePostgrestFilterValue)
//
// tests/unit/lib/api/postgrest.test.ts already exists and covers the basic
// reserved-character cases; this extends the corpus with the full adversarial
// payload set plus the individual reserved characters, without duplicating
// its existing cases.
// ---------------------------------------------------------------------------

describe("escapePostgrestFilterValue — extended adversarial corpus (Part B)", () => {
  const RESERVED_CHARS = [",", "(", ")", ".", '"', "\\"];

  it.each([...ALL_PAYLOADS, ...RESERVED_CHARS])(
    "round-trips %j (unescape(escape(x)) === x)",
    (payload) => {
      const escaped = escapePostgrestFilterValue(payload);
      const unescaped = escaped.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
      expect(unescaped).toBe(payload);
    },
  );

  it.each([...ALL_PAYLOADS, ...RESERVED_CHARS])(
    "every %j in the escaped output has no unescaped double quote",
    (payload) => {
      const escaped = escapePostgrestFilterValue(payload);
      // No `"` may appear that isn't immediately preceded by `\`.
      expect(escaped).not.toMatch(/(^|[^\\])"/);
    },
  );
});

// ---------------------------------------------------------------------------
// Part C — handler-level escaping
//
// GET /api/songs?q= (listSongs) is already covered by
// tests/unit/app/api/songs-search-injection-tester-supplement.test.ts — not
// duplicated here.
// ---------------------------------------------------------------------------

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { createGuestInvitation } from "@/app/api/invitations/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

function makeReq(body: unknown): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams() },
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeLookup(): UserLookup {
  const ctx: AuthContext = { userId: "user-1", churchGroupId: "group-1", role: "admin" };
  return async () => ctx;
}

function setUpAuth() {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue("supabase-jwt"),
  });
}

// Chainable query-builder double, mirroring
// songs-search-injection-tester-supplement.test.ts's makeChain style.
function makeChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> & PromiseLike<typeof result> = {
    select: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    is: jest.fn(() => chain),
    limit: jest.fn(() => Promise.resolve(result)),
    insert: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<typeof result>;
  return chain;
}

function makeGuestInvitationSupabase(onIlike: (col: string, val: string) => void) {
  const weekChain = makeChain({ data: { service_date: "2026-01-01" }, error: null });
  const usersChain = makeChain({ data: [], error: null });
  (usersChain.ilike as jest.Mock) = jest.fn((col: string, val: string) => {
    onIlike(col, val);
    return usersChain;
  });
  const invitationsChain = makeChain({
    data: { id: "inv-1", response_token: "tok", service_week_id: "22222222-2222-2222-2222-222222222222" },
    error: null,
  });

  const from = jest.fn((table: string) => {
    if (table === "service_weeks") return weekChain;
    if (table === "users") return usersChain;
    if (table === "invitations") return invitationsChain;
    return makeChain({ data: null, error: null });
  });
  const rpc = jest.fn().mockResolvedValue({ data: { id: "guest-user-1" }, error: null });
  return { from, rpc };
}

describe("createGuestInvitation — escapeLikePattern (handler-level, Part C)", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
  });

  it("backslash-escapes an underscore in the .ilike() argument", async () => {
    setUpAuth();
    let capturedArg = "";
    mockGetSupabaseClient.mockReturnValue(
      makeGuestInvitationSupabase((_col, val) => {
        capturedArg = val;
      }),
    );

    const email = "a_b@example.com";
    const res = await createGuestInvitation(
      makeReq({ serviceWeekId: "22222222-2222-2222-2222-222222222222", email }),
      makeLookup(),
    );
    expect(res.status).not.toBe(400);
    expect(capturedArg).toBe("a\\_b@example.com");
  });

  // % and \ never reach escapeLikePattern through this endpoint: Zod's
  // .email() format check (schemas/invitations.ts createGuestInvitationSchema)
  // rejects any local-part containing either character before the handler
  // body ever runs, independent of escapeLikePattern's own correctness. This
  // is a real (if incidental) defense-in-depth finding — see
  // .pipeline/changes.md SECURITY FINDINGS.
  it.each(["a%b@example.com", "a\\b@example.com", "a%b\\c@example.com"])(
    "%j is rejected by schema validation before ever reaching escapeLikePattern",
    async (email) => {
      setUpAuth();
      const res = await createGuestInvitation(
        makeReq({ serviceWeekId: "22222222-2222-2222-2222-222222222222", email }),
        makeLookup(),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
      expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    },
  );
});
