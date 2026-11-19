/**
 * Static checks for the chat tables migration (issue #208, P2-01).
 * Runs without a database: reads the migration SQL and asserts its shape.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..", "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const MIGRATION_NAME = "20261116000001_chat_tables_rls.sql";

const sql = readFileSync(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
const DOWN_MARKER = "-- ============ DOWN ============";
const downIdx = sql.indexOf(DOWN_MARKER);
const up = downIdx === -1 ? sql : sql.slice(0, downIdx);
const down = downIdx === -1 ? "" : sql.slice(downIdx + DOWN_MARKER.length);

/** Collapse whitespace and lowercase for tolerant matching. */
const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
const upN = norm(up);

function stripComments(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}

function policyBlock(name: string): string {
  const start = upN.indexOf(`create policy ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = upN.indexOf("create policy", start + 1);
  return upN.slice(start, end === -1 ? undefined : end);
}

describe("invitee invitation update guard migration (static)", () => {
  const guardSql = readFileSync(
    join(MIGRATIONS_DIR, "20261116000002_invitations_invitee_update_guard.sql"),
    "utf8",
  );
  const guardDownIdx = guardSql.indexOf(DOWN_MARKER);
  const guardUp = norm(stripComments(guardSql.slice(0, guardDownIdx)));

  it("installs a BEFORE UPDATE row trigger on invitations", () => {
    expect(guardUp).toContain(
      "create trigger invitations_guard_invitee_update before update on public.invitations for each row execute function public.invitations_guard_invitee_update();",
    );
  });

  it("is SECURITY INVOKER so current_user identifies a direct update", () => {
    expect(guardUp).not.toContain("security definer");
    expect(guardUp).toContain("if current_user <> 'authenticated' then return new;");
    expect(guardUp).toContain("set search_path = ''");
  });

  it("exempts leaders and admins", () => {
    expect(guardUp).toContain("public.auth_is_leader_or_admin()");
  });

  it("whitelists exactly the response columns and only pending -> denied", () => {
    expect(guardUp).toContain("array['status', 'denial_reason', 'denial_count', 'responded_at']");
    expect(guardUp).toContain("old.status <> 'pending' or new.status <> 'denied'");
    // Accepting must go through accept_invitation(), never a direct update.
    expect(guardUp).not.toContain("'accepted'");
    expect(guardUp).toContain("using errcode = '42501'");
  });

  it("has a fully commented DOWN block that drops the trigger and function", () => {
    expect(guardDownIdx).toBeGreaterThan(0);
    const lines = guardSql
      .slice(guardDownIdx + DOWN_MARKER.length)
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l.trimStart().startsWith("--")).toBe(true);
    expect(lines.join(" ")).toContain("DROP TRIGGER IF EXISTS invitations_guard_invitee_update");
    expect(lines.join(" ")).toContain("DROP FUNCTION IF EXISTS public.invitations_guard_invitee_update()");
  });
});

describe("users privileged-column guard migration (static)", () => {
  const usersSql = readFileSync(
    join(MIGRATIONS_DIR, "20261116000003_users_privileged_column_guard.sql"),
    "utf8",
  );
  const usersDownIdx = usersSql.indexOf(DOWN_MARKER);
  const usersUp = norm(stripComments(usersSql.slice(0, usersDownIdx)));

  it("installs a BEFORE UPDATE row trigger on users", () => {
    expect(usersUp).toContain(
      "create trigger users_guard_privileged_columns before update on public.users for each row execute function public.users_guard_privileged_columns();",
    );
  });

  it("is SECURITY INVOKER and only applies to direct authenticated updates", () => {
    expect(usersUp).not.toContain("security definer");
    expect(usersUp).toContain("if current_user <> 'authenticated' then return new;");
    expect(usersUp).toContain("set search_path = ''");
  });

  it("makes id, clerk_id and church_group_id immutable with no role exemption", () => {
    const immutable = usersUp.slice(
      usersUp.indexOf("if new.id is distinct from old.id"),
      usersUp.indexOf("if new.role is distinct from old.role"),
    );
    expect(immutable).toContain("new.clerk_id is distinct from old.clerk_id");
    expect(immutable).toContain("new.church_group_id is distinct from old.church_group_id");
    expect(immutable).toContain("using errcode = '42501'");
    expect(immutable).not.toContain("auth_");
  });

  it("lets only admins change role", () => {
    expect(usersUp).toContain(
      "if new.role is distinct from old.role and public.auth_user_role() is distinct from 'admin'::public.user_role then raise exception",
    );
    expect(usersUp).not.toContain("auth_is_leader_or_admin");
  });

  it("has a fully commented DOWN block that drops the trigger and function", () => {
    expect(usersDownIdx).toBeGreaterThan(0);
    const lines = usersSql
      .slice(usersDownIdx + DOWN_MARKER.length)
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l.trimStart().startsWith("--")).toBe(true);
    expect(lines.join(" ")).toContain("DROP TRIGGER IF EXISTS users_guard_privileged_columns");
    expect(lines.join(" ")).toContain("DROP FUNCTION IF EXISTS public.users_guard_privileged_columns()");
  });
});

describe("chat tables migration (static)", () => {
  it.each(["chat_rooms", "chat_messages", "chat_mentions"])("creates table %s", (t) => {
    expect(upN).toMatch(new RegExp(`create table (public\\.)?${t}\\b`));
  });

  it("chat_rooms.service_week_id is unique", () => {
    expect(upN).toMatch(/service_week_id uuid not null unique references service_weeks/);
  });

  it("enforces 2000-character content limit", () => {
    expect(upN).toContain("char_length(content) <= 2000");
  });

  it("defines chat_message_kind with text and devotion", () => {
    expect(upN).toMatch(/create type public\.chat_message_kind as enum \('text', 'devotion'\)/);
  });

  it("metadata is nullable jsonb", () => {
    expect(upN).toMatch(/metadata jsonb(,|\s*\))/);
    expect(upN).not.toMatch(/metadata jsonb not null/);
  });

  it.each(["chat_rooms", "chat_messages", "chat_mentions"])("enables RLS on %s", (t) => {
    expect(upN).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security`));
  });

  it("is_chat_room_member is SECURITY DEFINER with empty search_path and checks accepted", () => {
    const start = upN.indexOf("function public.is_chat_room_member");
    expect(start).toBeGreaterThanOrEqual(0);
    const fn = upN.slice(start, upN.indexOf("$$;", upN.indexOf("$$", start + 40) + 2));
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = ''");
    expect(fn).toContain("status = 'accepted'");
  });

  it("chat_messages INSERT policy refuses archived rooms", () => {
    expect(policyBlock("chat_messages_insert_member")).toContain("is_archived = false");
  });

  it("authenticated callers may only UPDATE chat_messages.is_deleted (soft-delete only)", () => {
    expect(upN).toContain("revoke update on public.chat_messages from authenticated, anon;");
    expect(upN).toContain("grant update (is_deleted) on public.chat_messages to authenticated;");
    // No broader re-grant sneaks back in.
    expect(upN).not.toMatch(/grant (all|update) on public\.chat_messages/);
    const block = policyBlock("chat_messages_update_own");
    const withCheck = block.slice(block.indexOf("with check"));
    expect(withCheck).toContain("is_deleted = true");
  });

  it("has no DELETE policy on any chat table", () => {
    expect(upN).not.toMatch(/create policy \S+ on public\.chat_\w+ for delete/);
    expect(upN).not.toMatch(/for delete/);
  });

  it("has a fully commented DOWN block", () => {
    expect(downIdx).toBeGreaterThan(0);
    const lines = down.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.trimStart().startsWith("--")).toBe(true);
    }
  });

  it("no other migration references chat_rooms outside comments", () => {
    const others = readdirSync(MIGRATIONS_DIR).filter(
      (f) => f.endsWith(".sql") && f !== MIGRATION_NAME,
    );
    for (const f of others) {
      const body = stripComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      expect({ file: f, mentions: /chat_rooms/i.test(body) }).toEqual({ file: f, mentions: false });
    }
  });
});
