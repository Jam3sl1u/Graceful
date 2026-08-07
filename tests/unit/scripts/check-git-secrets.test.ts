// Integration-style tests for scripts/check-git-secrets.mjs: real git/node
// subprocesses against disposable scratch repos under os.tmpdir(). The
// behavior under test (git history semantics, shallow-clone detection, exit
// codes) is only meaningfully verified end-to-end.

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT_PATH = path.resolve(__dirname, "../../../scripts/check-git-secrets.mjs");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "scratch@test.local"]);
  git(dir, ["config", "user.name", "Scratch"]);
}

function commitFile(dir: string, relPath: string, content: string, message: string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  git(dir, ["add", relPath]);
  git(dir, ["commit", "-q", "-m", message]);
}

function runScanner(cwd: string) {
  return spawnSync("node", [SCRIPT_PATH], { cwd, encoding: "utf8" });
}

let scratchDirs: string[] = [];

function makeScratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-git-secrets-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  scratchDirs = [];
});

describe("check-git-secrets.mjs", () => {
  it("exits 0 against a clean scratch repo with no secrets", () => {
    const repo = makeScratchDir();
    initRepo(repo);
    commitFile(repo, "readme.txt", "Hello, world.\n", "initial commit");

    const result = runScanner(repo);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK:");
  });

  it("exits 1 and redacts a fake Clerk secret key found in history", () => {
    const repo = makeScratchDir();
    initRepo(repo);
    const secret = "sk_live_N4kQpLxZbVvGhTsWjRfYcMdEoIaBcDeF";
    commitFile(repo, "config.txt", `CLERK_SECRET_KEY=${secret}\n`, "add fake key");

    const result = runScanner(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Clerk secret key");
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).toContain(`sk_l…(len=${secret.length})`);
  });

  it("still flags a committed .env file even after it's deleted in a later commit", () => {
    const repo = makeScratchDir();
    initRepo(repo);
    commitFile(repo, ".env", "SOME_VAR=1\n", "add .env");
    fs.rmSync(path.join(repo, ".env"));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "remove .env"]);

    const result = runScanner(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Committed .env file");
  });

  it("does not flag a committed .env.example", () => {
    const repo = makeScratchDir();
    initRepo(repo);
    commitFile(repo, ".env.example", "SOME_VAR=\n", "add .env.example");

    const result = runScanner(repo);

    expect(result.status).toBe(0);
  });

  it("exits 1 with a 'shallow' message against a shallow clone, before reporting clean", () => {
    const origin = makeScratchDir();
    initRepo(origin);
    commitFile(origin, "a.txt", "one\n", "first");
    commitFile(origin, "b.txt", "two\n", "second");

    const shallow = makeScratchDir();
    fs.rmdirSync(shallow);
    execFileSync(
      "git",
      ["clone", "--quiet", "--depth", "1", "--no-local", `file://${origin}`, shallow],
      { encoding: "utf8" },
    );

    const result = runScanner(shallow);

    expect(result.status).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("shallow");
  });

  it("exits 1 with a git-working-tree message when run outside any git repo", () => {
    const notARepo = makeScratchDir();

    const result = runScanner(notARepo);

    expect(result.status).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("git working tree");
  });

  it("still scans a path containing 'check-git-secrets' that is not under tests/ (narrowed path bypass)", () => {
    const repo = makeScratchDir();
    initRepo(repo);
    const secret = "sk_live_ZxWvUtSrQpOnMlKjIhGfEdCbAyXw";
    commitFile(
      repo,
      "scripts/check-git-secrets-notes.md",
      `Do not commit real keys like ${secret}\n`,
      "add notes file",
    );

    const result = runScanner(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Clerk secret key");
  });

  it("suppresses a finding whose matched value contains an allowlist substring like 'example'", () => {
    const repo = makeScratchDir();
    initRepo(repo);
    // "example" appears mid-string inside an otherwise secret-shaped value —
    // VALUE_ALLOWLIST does substring matching by design (see the comment
    // above VALUE_ALLOWLIST in check-git-secrets.mjs), so this must still be
    // suppressed even though it isn't a whole-string match of /example/i.
    commitFile(
      repo,
      "config.txt",
      "CLERK_SECRET_KEY=sk_live_exampleFakeNotARealKey1234\n",
      "add example-flavored fake key",
    );

    const result = runScanner(repo);

    expect(result.status).toBe(0);
  });
});
