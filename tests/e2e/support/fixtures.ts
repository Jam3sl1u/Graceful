/**
 * Service-role seeding + teardown for the staging E2E suite (issue #52).
 *
 * Mirrors tests/integration/rls/setup.ts's stable-IDS + service-client seed
 * pattern ("Reuse its seed persona shape (admin/member in one church group)
 * rather than inventing new fixtures" — .pipeline/spec.md), with one
 * necessary difference: `users.clerk_id` is UNIQUE
 * (supabase/migrations/20260702000001_cluster_1_organization.sql), and the
 * admin/member Clerk identities are real, pre-provisioned staging accounts
 * (OQ1) — so, unlike the RLS suite's fake per-tenant clerk_ids, we can't
 * mint a fresh church_group + admin/member trio per test without colliding
 * on that constraint. Instead the admin/member/church-group fixture is
 * STABLE (fixed IDs below, idempotently upserted once in
 * global-setup.ts's ensureChurchFixture), and every test seeds+tears down
 * only the variable per-test entities (service_weeks, invitations,
 * conflicts, notifications, availability) with fresh UUIDs/dates. This is
 * also why playwright.config.ts pins `workers: 1` / `fullyParallel: false`
 * for this suite — two tests must never touch the shared admin/member rows
 * concurrently (e.g. the self-exclusion test in conflict-detection.spec.ts
 * temporarily elevates the member's role).
 */

import { createClerkClient } from "@clerk/backend";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env";

export const FIXTURE = {
  churchGroupId: "e0000000-0000-4000-9000-000000000001",
  adminUserId: "e0000000-0000-4000-9000-000000000002",
  memberUserId: "e0000000-0000-4000-9000-000000000003",
} as const;

const clerkUserIdCache = new Map<string, string>();

// Resolves the real Clerk user id (the `sub` claim a signed-in session's JWT
// will carry) for a seeded staging test user's email, via Clerk's Backend
// API. Cached per process — these are static, pre-provisioned accounts.
export async function resolveClerkUserId(email: string): Promise<string> {
  const cached = clerkUserIdCache.get(email);
  if (cached) return cached;

  const clerk = createClerkClient({ secretKey: requireEnv("CLERK_SECRET_KEY") });
  const { data } = await clerk.users.getUserList({ emailAddress: [email] });
  const user = data[0];
  if (!user) {
    throw new Error(
      `No Clerk user found for seeded E2E test email "${email}" — provision it in the staging ` +
        "Clerk test-mode instance first (OQ1, documentation/staging-environment.md).",
    );
  }

  clerkUserIdCache.set(email, user.id);
  return user.id;
}

// Idempotently seeds/updates the stable admin/member/church fixture. Safe to
// call every run (upsert by primary key) — the Clerk identities behind
// E2E_ADMIN_EMAIL/E2E_MEMBER_EMAIL don't change, so re-upserting is a no-op
// after the first run.
export async function ensureChurchFixture(svc: SupabaseClient): Promise<void> {
  const { error: churchError } = await svc.from("church_groups").upsert(
    {
      id: FIXTURE.churchGroupId,
      name: "E2E Fixture Church",
      denomination: null,
      timezone: "America/Chicago",
      invite_code: "E2E-FIXTURE-CHURCH",
    },
    { onConflict: "id" },
  );
  if (churchError) {
    throw new Error(`ensureChurchFixture: church_groups upsert failed: ${churchError.message}`);
  }

  const [adminClerkId, memberClerkId] = await Promise.all([
    resolveClerkUserId(requireEnv("E2E_ADMIN_EMAIL")),
    resolveClerkUserId(requireEnv("E2E_MEMBER_EMAIL")),
  ]);

  const { error: usersError } = await svc.from("users").upsert(
    [
      {
        id: FIXTURE.adminUserId,
        clerk_id: adminClerkId,
        church_group_id: FIXTURE.churchGroupId,
        role: "admin",
        name: "E2E Fixture Admin",
        email: requireEnv("E2E_ADMIN_EMAIL"),
        phone: null,
        sms_opted_in: false,
        anonymized_at: null,
      },
      {
        id: FIXTURE.memberUserId,
        clerk_id: memberClerkId,
        church_group_id: FIXTURE.churchGroupId,
        role: "member",
        name: "E2E Fixture Member",
        email: requireEnv("E2E_MEMBER_EMAIL"),
        phone: null,
        sms_opted_in: false,
        anonymized_at: null,
      },
    ],
    { onConflict: "id" },
  );
  if (usersError) {
    throw new Error(`ensureChurchFixture: users upsert failed: ${usersError.message}`);
  }
}

// Temporarily changes the stable member fixture's role — used only by the
// conflict-detection self-exclusion test. Always restore ("member") in a
// `finally` block; safe only because playwright.config.ts serializes this
// suite (workers: 1).
export async function setMemberRole(
  svc: SupabaseClient,
  role: "member" | "set_leader",
): Promise<void> {
  const { error } = await svc.from("users").update({ role }).eq("id", FIXTURE.memberUserId);
  if (error) throw new Error(`setMemberRole failed: ${error.message}`);
}

export function futureDateString(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

// 64-char hex response token — same shape as generateResponseToken in
// app/api/invitations/handler.ts.
export function generateResponseToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export async function seedServiceWeek(
  svc: SupabaseClient,
  churchGroupId: string,
  serviceDate: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const { error } = await svc.from("service_weeks").insert({
    id,
    church_group_id: churchGroupId,
    service_date: serviceDate,
    title: `E2E Service ${serviceDate}`,
  });
  if (error) throw new Error(`seedServiceWeek failed: ${error.message}`);
  return id;
}

export type SeedInvitationOpts = {
  churchGroupId: string;
  serviceWeekId: string;
  userId: string;
  invitedBy: string;
  status?: "pending" | "accepted";
  createdAt?: string;
};

export async function seedInvitation(
  svc: SupabaseClient,
  opts: SeedInvitationOpts,
): Promise<{ id: string; responseToken: string }> {
  const id = crypto.randomUUID();
  const responseToken = generateResponseToken();
  const { error } = await svc.from("invitations").insert({
    id,
    church_group_id: opts.churchGroupId,
    service_week_id: opts.serviceWeekId,
    user_id: opts.userId,
    role_note: null,
    status: opts.status ?? "pending",
    response_token: responseToken,
    invited_by: opts.invitedBy,
    created_at: opts.createdAt,
  });
  if (error) throw new Error(`seedInvitation failed: ${error.message}`);
  return { id, responseToken };
}

export type TeardownIds = {
  serviceWeekId?: string;
  invitationId?: string;
  conflictId?: string;
  notificationLinkEntityIds?: string[];
  availability?: { userId: string; date: string };
};

// Per-test cleanup — deletes only the variable fixtures a test created
// (never the stable admin/member/church-group rows). Order matches the
// tables' FK dependencies (children first).
export async function teardownFixtures(svc: SupabaseClient, ids: TeardownIds): Promise<void> {
  for (const linkEntityId of ids.notificationLinkEntityIds ?? []) {
    await svc.from("notifications").delete().eq("link_entity_id", linkEntityId);
  }
  if (ids.availability) {
    await svc
      .from("availability")
      .delete()
      .eq("user_id", ids.availability.userId)
      .eq("date", ids.availability.date);
  }
  if (ids.conflictId) {
    await svc.from("conflicts").delete().eq("id", ids.conflictId);
  }
  if (ids.invitationId) {
    await svc.from("invitations").delete().eq("id", ids.invitationId);
  }
  if (ids.serviceWeekId) {
    await svc.from("service_weeks").delete().eq("id", ids.serviceWeekId);
  }
}
