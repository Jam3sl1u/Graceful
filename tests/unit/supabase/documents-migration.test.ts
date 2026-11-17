/**
 * Static checks for the documents migration (issue #216, P2-09).
 * Runs without a database: reads the migration SQL and asserts its shape.
 */

import { readFileSync } from "fs";
import { join } from "path";

const sql = readFileSync(
  join(__dirname, "..", "..", "..", "supabase", "migrations", "20261117000001_documents_table_rls.sql"),
  "utf8",
);
const DOWN_MARKER = "-- ============ DOWN ============";
const downIdx = sql.indexOf(DOWN_MARKER);
const norm = (s: string) =>
  s
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\s+/g, " ")
    .toLowerCase();
const up = norm(sql.slice(0, downIdx));

function policy(name: string): string {
  const start = up.indexOf(`create policy ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = up.indexOf("create policy", start + 1);
  return up.slice(start, end === -1 ? undefined : end);
}

describe("documents migration (static)", () => {
  it("creates the documents table with the PRD §20.6 columns", () => {
    expect(up).toContain("create table public.documents");
    for (const col of [
      "church_group_id uuid not null references church_groups(id) on delete cascade",
      "name varchar(200) not null",
      "file_key text not null unique",
      "file_type varchar(50) not null",
      "file_size_bytes integer not null",
      "folder varchar(100) not null default 'general'",
      "description text",
      "uploaded_by uuid references users(id) on delete set null",
    ]) {
      expect(up).toContain(col);
    }
  });

  it("does not link documents to songs or service weeks", () => {
    expect(up).not.toContain("song_id");
    expect(up).not.toContain("service_week_id");
    expect(up).not.toContain("song_documents");
  });

  it("enables RLS", () => {
    expect(up).toContain("alter table public.documents enable row level security");
  });

  it("lets every non-guest role in the group read, and excludes guests", () => {
    const p = policy("documents_select_non_guest");
    expect(p).toContain("for select to authenticated");
    expect(p).toContain("church_group_id = public.auth_church_group_id()");
    expect(p).toContain("public.auth_user_role() in ('admin', 'set_leader', 'member')");
    expect(p).not.toContain("'guest'");
  });

  it("lets only admins insert, as themselves, in their own group", () => {
    const p = policy("documents_insert_admin");
    expect(p).toContain("for insert to authenticated");
    expect(p).toContain("church_group_id = public.auth_church_group_id()");
    expect(p).toContain("public.auth_user_role() = 'admin'");
    expect(p).toContain("uploaded_by = public.auth_user_id()");
  });

  it("lets only admins delete, in their own group", () => {
    const p = policy("documents_delete_admin");
    expect(p).toContain("for delete to authenticated");
    expect(p).toContain("church_group_id = public.auth_church_group_id()");
    expect(p).toContain("public.auth_user_role() = 'admin'");
  });

  it("has exactly three policies and no UPDATE policy", () => {
    expect(up.match(/create policy/g)).toHaveLength(3);
    expect(up).not.toContain("for update");
    expect(up).not.toContain("for all");
  });

  it("has a fully commented DOWN block", () => {
    expect(downIdx).toBeGreaterThan(0);
    const lines = sql
      .slice(downIdx + DOWN_MARKER.length)
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.trimStart().startsWith("--")).toBe(true);
  });
});
