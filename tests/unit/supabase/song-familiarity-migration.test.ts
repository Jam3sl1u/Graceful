/**
 * Static checks for the song_familiarity migration (issue #221, P2-14).
 * Runs without a database: reads the migration SQL and asserts its shape.
 */

import { readFileSync } from "fs";
import { join } from "path";

const sql = readFileSync(
  join(__dirname, "..", "..", "..", "supabase", "migrations", "20261117000002_song_familiarity.sql"),
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

describe("song_familiarity migration (static)", () => {
  it("defines the three levels and the table, unique per user and song", () => {
    expect(up).toContain(
      "create type public.song_familiarity_level as enum ('comfortable', 'learning', 'not_learned')",
    );
    expect(up).toContain("create table public.song_familiarity");
    expect(up).toContain("unique (user_id, song_id)");
    expect(up).toContain("song_id uuid not null references songs(id) on delete cascade");
    expect(up).toContain("user_id uuid not null references users(id) on delete cascade");
  });

  it("enables RLS", () => {
    expect(up).toContain("alter table public.song_familiarity enable row level security");
  });

  it("members read only their own rows; leaders and admins read the group's", () => {
    expect(policy("song_familiarity_select_own")).toContain("user_id = public.auth_user_id()");
    const wide = policy("song_familiarity_select_leader_admin");
    expect(wide).toContain("public.auth_is_leader_or_admin()");
    expect(wide).toContain("church_group_id = public.auth_church_group_id()");
  });

  it("writes are own-row only, non-guest, and the song must be in the caller's group", () => {
    for (const name of ["song_familiarity_insert_own", "song_familiarity_update_own"]) {
      const p = policy(name);
      expect(p).toContain("user_id = public.auth_user_id()");
      expect(p).toContain("public.auth_user_role() in ('admin', 'set_leader', 'member')");
      expect(p).toContain("s.church_group_id = public.auth_church_group_id()");
    }
    expect(policy("song_familiarity_delete_own")).toContain("user_id = public.auth_user_id()");
  });

  it("gives leaders and admins no write access to other people's rows", () => {
    for (const name of [
      "song_familiarity_insert_own",
      "song_familiarity_update_own",
      "song_familiarity_delete_own",
    ]) {
      expect(policy(name)).not.toContain("auth_is_leader_or_admin");
    }
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
