/**
 * Token-level bypass matrix (issue #80, AC-2).
 *
 * tests/integration/rls/tables/cross-tenant-bypass.test.ts (#33) already
 * sweeps a same-issuer-but-wrong-tenant persona (Church A vs Church B) across
 * all verbs. This file covers the vectors that suite does not: an
 * unauthenticated caller, an expired-but-otherwise-valid JWT, and a
 * wrong-signature JWT — plus block A's mechanical coverage pin so a future
 * table added to the schema cannot silently skip the cross-tenant sweep.
 *
 * Block E additionally pins the trust-boundary behavior of
 * public.auth_church_group_id() / public.auth_user_role()
 * (supabase/migrations/20260704000001_rls_policies.sql:29-53): both read the
 * `church_group_id` / `role` JWT claims *first*, falling back to the DB only
 * when the claim is absent. A JWT signed by the trusted issuer (Clerk, or in
 * these tests SUPABASE_JWT_SECRET) with a forged claim is therefore
 * authoritative — the security of this entire path rests entirely on only
 * Clerk being able to mint these claims in production. #79 (OWASP review)
 * should inherit this as an accurate picture of the trust boundary, not
 * treat it as a bug to "fix" by itself.
 */

import * as fs from "fs";
import * as path from "path";
import { getUserClient, getAnonClient } from "../client";
import { IDS, rlsTestsEnabled, seedViaServiceClient } from "../setup";
import { assertSelectBlocked } from "../helpers";

const skip = !rlsTestsEnabled || !process.env.SUPABASE_TEST_URL;

const describeRls = skip ? describe.skip : describe;

// 19 tables — matches supabase/migrations/20260704000001_rls_policies.sql
export const PHASE1_TABLES = [
  "church_groups", "users", "member_profiles", "instruments",
  "member_instruments", "service_weeks", "setlists", "setlist_songs",
  "events", "invitations", "event_attendees", "conflicts", "songs",
  "song_documents", "availability", "notification_preferences",
  "notifications", "google_calendar_tokens", "audit_logs",
] as const;

const WRONG_SIGNING_SECRET = "not-the-real-secret-not-the-real-secret";

// ── A. Coverage pin — runs unconditionally, no RLS env vars required ───────

describe("PHASE1_TABLES coverage pin (runs without RLS env vars)", () => {
  it("has exactly 19 tables", () => {
    expect(PHASE1_TABLES.length).toBe(19);
  });

  it("every PHASE1_TABLES entry appears in cross-tenant-bypass.test.ts", () => {
    const crossTenantPath = path.resolve(__dirname, "./cross-tenant-bypass.test.ts");
    const source = fs.readFileSync(crossTenantPath, "utf8");

    for (const table of PHASE1_TABLES) {
      expect(source).toContain(table);
    }
  });
});

describeRls("Token-level bypass matrix (Phase 1 tables)", () => {
  beforeAll(async () => {
    await seedViaServiceClient();
  }, 60_000);

  // ── B. Unauthenticated caller ─────────────────────────────────────────
  describe("B. Unauthenticated caller (getAnonClient)", () => {
    it.each(PHASE1_TABLES)("SELECT id on %s returns zero rows or an error", async (table) => {
      await assertSelectBlocked(getAnonClient(), table);
    });
  });

  // ── C. Expired Church A JWT ────────────────────────────────────────────
  describe("C. Expired Church A JWT", () => {
    it.each(PHASE1_TABLES)("SELECT id on %s returns zero rows or an error", async (table) => {
      const expiredMemberA = getUserClient({
        clerkId: IDS.clerkIds.memberA,
        expiresInSeconds: -60,
      });
      await assertSelectBlocked(expiredMemberA, table);
    });
  });

  // ── D. Wrong-signature JWT ─────────────────────────────────────────────
  describe("D. Wrong-signature JWT", () => {
    it.each(PHASE1_TABLES)("SELECT id on %s returns zero rows or an error", async (table) => {
      const forgedAdminA = getUserClient({
        clerkId: IDS.clerkIds.adminA,
        signingSecret: WRONG_SIGNING_SECRET,
      });
      await assertSelectBlocked(forgedAdminA, table);
    });
  });

  // ── E. Trust-boundary characterization (3 tests, NOT a sweep) ──────────
  describe("E. Trust-boundary characterization (trusted-issuer assumption)", () => {
    it("church_group_id JWT claim overrides the DB value (trusted-issuer assumption)", async () => {
      // Church A member's JWT carries a forged church_group_id claim
      // pointing at Church B. auth_church_group_id() reads the claim first
      // (COALESCE), so this client is treated as scoped to Church B for RLS
      // purposes, regardless of the DB row for this clerk_id.
      const forgedClaimClient = getUserClient({
        clerkId: IDS.clerkIds.memberA,
        churchGroupId: IDS.churches.B,
      });

      const { data, error } = await forgedClaimClient
        .from("songs")
        .select("id")
        .eq("church_group_id", IDS.churches.B);

      // Recorded, not asserted-safe: with a trusted-issuer JWT carrying this
      // claim, the caller reads Church B's songs. See file header — this is
      // exactly the trust assumption RLS relies on Clerk to uphold.
      expect(error).toBeNull();
      expect((data ?? []).length).toBeGreaterThan(0);
    });

    it("appRole 'admin' JWT claim overrides the DB role (trusted-issuer assumption)", async () => {
      // Church A member's JWT carries a forged appRole claim of "admin".
      // auth_user_role() reads the claim first, so this client is treated
      // as an admin of Church A for RLS purposes, regardless of the DB
      // role column for this clerk_id.
      const forgedRoleClient = getUserClient({
        clerkId: IDS.clerkIds.memberA,
        appRole: "admin",
      });

      const { data, error } = await forgedRoleClient
        .from("audit_logs")
        .select("id")
        .eq("church_group_id", IDS.churches.A);

      // Recorded, not asserted-safe: with a trusted-issuer JWT carrying this
      // claim, the caller reads Church A's admin-only audit_logs.
      expect(error).toBeNull();
      expect((data ?? []).length).toBeGreaterThan(0);
    });

    it("a non-uuid church_group_id claim errors rather than falling back to the DB value", async () => {
      const invalidClaimClient = getUserClient({
        clerkId: IDS.clerkIds.memberA,
        churchGroupId: "not-a-uuid",
      });

      const { error } = await invalidClaimClient.from("songs").select("id");

      // ::uuid cast on the JWT claim throws in Postgres before COALESCE can
      // fall back to the DB value — a malformed claim must error, not
      // silently grant the DB-derived scope.
      expect(error).not.toBeNull();
    });
  });
});
