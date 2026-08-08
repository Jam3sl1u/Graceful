// Integration-style tests for scripts/check-owasp-review.mjs: real node
// subprocesses against disposable fixture files under os.tmpdir(). Mirrors
// the pattern in tests/unit/scripts/check-git-secrets.test.ts.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT_PATH = path.resolve(__dirname, "../../../scripts/check-owasp-review.mjs");
const REAL_DOC_PATH = path.resolve(__dirname, "../../../documentation/owasp-top-10-review.md");

function runCheck(args: string[]) {
  return spawnSync("node", [SCRIPT_PATH, ...args], { encoding: "utf8" });
}

// A minimal, well-formed doc: all five required categories, each with a
// single "no issues found" row.
function minimalDoc(): string {
  const categories: Array<[string, string]> = [
    ["A01", "Broken Access Control"],
    ["A02", "Cryptographic Failures"],
    ["A03", "Injection"],
    ["A05", "Security Misconfiguration"],
    ["A07", "Identification and Authentication Failures"],
  ];

  const sections = categories
    .map(
      ([code, title]) => `## ${code}:2021 — ${title}

### Findings

| ID | Severity | Status | Summary | Evidence | Resolution |
| -- | -------- | ------ | ------- | -------- | ---------- |
| ${code}-0 | Info | Resolved | No issues found | n/a | Reviewed, nothing to report. |
`,
    )
    .join("\n");

  return `# OWASP Top 10 (2021) Manual Review — Phase 1 Pre-Launch\n\n${sections}`;
}

let scratchDirs: string[] = [];

function writeFixture(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-owasp-review-"));
  scratchDirs.push(dir);
  const filePath = path.join(dir, "review.md");
  fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const dir of scratchDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  scratchDirs = [];
});

describe("check-owasp-review.mjs", () => {
  it("exits 0 against a minimal well-formed doc with all five categories", () => {
    const fixturePath = writeFixture(minimalDoc());

    const result = runCheck([fixturePath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK:");
  });

  it("exits 0 against the real documentation/owasp-top-10-review.md (default path resolution)", () => {
    const result = runCheck([]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK:");
  });

  it("also exits 0 when given the real doc's path explicitly", () => {
    const result = runCheck([REAL_DOC_PATH]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK:");
  });

  it("exits 1 and names A05 when the doc is missing the A05 section", () => {
    const doc = minimalDoc().replace(
      /## A05:2021 — Security Misconfiguration[\s\S]*?(?=## A07:2021)/,
      "",
    );
    const fixturePath = writeFixture(doc);

    const result = runCheck([fixturePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A05");
  });

  it("exits 1 and names the finding ID for a High + Deferred row", () => {
    const doc = minimalDoc().replace(
      "| A02-0 | Info | Resolved | No issues found | n/a | Reviewed, nothing to report. |",
      "| A02-1 | High | Deferred | Some real issue | some/file.ts | Deferred pending follow-up. |",
    );
    const fixturePath = writeFixture(doc);

    const result = runCheck([fixturePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A02-1");
  });

  it("exits 1 for a Low + Open row (Open blocks at any severity)", () => {
    const doc = minimalDoc().replace(
      "| A03-0 | Info | Resolved | No issues found | n/a | Reviewed, nothing to report. |",
      "| A03-1 | Low | Open | Some minor issue | some/file.ts | Not yet triaged. |",
    );
    const fixturePath = writeFixture(doc);

    const result = runCheck([fixturePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A03-1");
  });

  it("exits 1 for a Severity value with the wrong case (e.g. 'high')", () => {
    const doc = minimalDoc().replace(
      "| A01-0 | Info | Resolved | No issues found | n/a | Reviewed, nothing to report. |",
      "| A01-1 | high | Resolved | Some issue | some/file.ts | Fixed. |",
    );
    const fixturePath = writeFixture(doc);

    const result = runCheck([fixturePath]);

    expect(result.status).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("severity");
  });

  it("exits 1 when a category's findings table has zero data rows", () => {
    const doc = minimalDoc().replace(
      "| A07-0 | Info | Resolved | No issues found | n/a | Reviewed, nothing to report. |\n",
      "",
    );
    const fixturePath = writeFixture(doc);

    const result = runCheck([fixturePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A07");
  });

  it("exits 1 for a nonexistent doc path", () => {
    const result = runCheck(["/no/such/path/review.md"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not found");
  });
});
