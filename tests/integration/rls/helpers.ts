/**
 * Assertion helpers for RLS integration tests.
 *
 * Thin wrappers that query a table as a specific user and assert the
 * expected isolation / visibility outcome.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserClient } from "./client";
import { IDS } from "./setup";

// ---------------------------------------------------------------------------
// Low-level assertion helpers
// ---------------------------------------------------------------------------

/** Assert that a SELECT returns zero rows (cross-tenant block). */
export async function expectEmpty(
  client: SupabaseClient,
  table: string,
): Promise<void> {
  const { data, error } = await client.from(table).select("id");
  if (error) {
    return; // policy denial is also acceptable
  }
  expect(data).toHaveLength(0);
}

/** Assert that a SELECT returns at least one row (same-tenant allow). */
export async function expectNonEmpty(
  client: SupabaseClient,
  table: string,
): Promise<void> {
  const { data, error } = await client.from(table).select("id");
  expect(error).toBeNull();
  expect((data ?? []).length).toBeGreaterThan(0);
}

/** Assert that a SELECT returns exactly one row with the given id. */
export async function expectRow(
  client: SupabaseClient,
  table: string,
  id: string,
): Promise<void> {
  const { data, error } = await client.from(table).select("id").eq("id", id);
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
  expect(((data as { id: string }[] | null) ?? [])[0]?.id).toBe(id);
}

/** Assert that a SELECT does NOT return a row with the given id. */
export async function expectNoRow(
  client: SupabaseClient,
  table: string,
  id: string,
): Promise<void> {
  const { data, error } = await client.from(table).select("id").eq("id", id);
  if (error) return; // policy denial is also acceptable
  const ids = (data ?? []).map((r: { id: string }) => r.id);
  expect(ids).not.toContain(id);
}

/** Assert that an INSERT is rejected by RLS (returns an error). */
export async function expectInsertDenied(
  client: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from(table).insert(row);
  expect(error).not.toBeNull();
}

/** Assert that an INSERT succeeds (no error). */
export async function expectInsertAllowed(
  client: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from(table).insert(row);
  expect(error).toBeNull();
}

// ---------------------------------------------------------------------------
// Named aliases used by the per-table test files in tests/integration/rls/tables/
// ---------------------------------------------------------------------------

/**
 * Assert that a SELECT with an optional column filter returns zero rows.
 * filter is a plain object of column → value pairs applied as .eq() calls.
 */
export async function assertSelectBlocked(
  client: SupabaseClient,
  table: string,
  filter: Record<string, unknown> = {},
): Promise<void> {
  let query = client.from(table).select("id");
  for (const [col, val] of Object.entries(filter)) {
    query = query.eq(col, val as string);
  }
  const { data, error } = await query;
  if (error) return; // policy denial counts as blocked
  expect(data).toHaveLength(0);
}

/**
 * Assert that a SELECT with an optional column filter returns at least one row.
 */
export async function assertSelectAllowed(
  client: SupabaseClient,
  table: string,
  filter: Record<string, unknown> = {},
): Promise<void> {
  let query = client.from(table).select("id");
  for (const [col, val] of Object.entries(filter)) {
    query = query.eq(col, val as string);
  }
  const { data, error } = await query;
  expect(error).toBeNull();
  expect((data ?? []).length).toBeGreaterThan(0);
}

/** Alias for expectInsertDenied — INSERT must return an error. */
export async function assertInsertDenied(
  client: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  return expectInsertDenied(client, table, row);
}

// ---------------------------------------------------------------------------
// Pre-built user clients keyed by seed persona
// ---------------------------------------------------------------------------

export const clients = {
  adminA:   () => getUserClient({ clerkId: IDS.clerkIds.adminA }),
  leaderA:  () => getUserClient({ clerkId: IDS.clerkIds.leaderA }),
  memberA:  () => getUserClient({ clerkId: IDS.clerkIds.memberA }),
  memberA2: () => getUserClient({ clerkId: IDS.clerkIds.memberA2 }),
  guestA:   () => getUserClient({ clerkId: IDS.clerkIds.guestA }),
  memberB:  () => getUserClient({ clerkId: IDS.clerkIds.memberB }),
  adminB:   () => getUserClient({ clerkId: IDS.clerkIds.adminB }),
} as const;
