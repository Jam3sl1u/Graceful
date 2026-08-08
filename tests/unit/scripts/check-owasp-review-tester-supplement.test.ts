// Independent Tester-stage supplement for scripts/check-owasp-review.mjs
// (issue #79). Covers parsing edge cases named in .pipeline/spec.md that
// aren't exercised by tests/unit/scripts/check-owasp-review.test.ts: escaped
// pipes inside table cells, "### " sub-headings not terminating a "## "
// section, the section-2 scan table being invisible to the parser, wrong
// column counts, ID-prefix mismatches, and a genuine failure case (a
// Critical+Open row) beyond what the coder's own suite covered.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT_PATH = path.resolve(__dirname, "../../../scripts/check-owasp-review.mjs");

function runCheck(args: string[]) {
  return spawnSync("node", [SCRIPT_PATH, ...args], { encoding: "utf8" });
}

let scratchDirs: string[] = [];

function writeFixture(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-owasp-review-supp-"));
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

function categorySection(
  code: string,
  title: string,
  tableRows: string,
  extra = "",
): string {
  return `## ${code}:2021 — ${title}

### Scope reviewed

- some/file.ts

### Method

- code read

### Findings

| ID | Severity | Status | Summary | Evidence | Resolution |
| -- | -------- | ------ | ------- | -------- | ---------- |
${tableRows}
${extra}
### Conclusion

Nothing further.
`;
}

function fullDoc(overrides: Partial<Record<string, string>> = {}): string {
  const categories: Array<[string, string]> = [
    ["A01", "Broken Access Control"],
    ["A02", "Cryptographic Failures"],
    ["A03", "Injection"],
    ["A05", "Security Misconfiguration"],
    ["A07", "Identification and Authentication Failures"],
  ];

  const sections = categories
    .map(([code, title]) => {
      const rows =
        overrides[code] ??
        `| ${code}-0 | Info | Resolved | No issues found | n/a | Reviewed, nothing to report. |`;
      return categorySection(code, title, rows);
    })
    .join("\n");

  return `# OWASP Top 10 (2021) Manual Review — Phase 1 Pre-Launch

## 1. Scope, method, and launch-gate policy

Prose only, no table here.

## 2. Dependency scans

| Scan | Command | Date | Commit | Result |
| ---- | ------- | ---- | ------ | ------ |
| bun audit | \`bun audit --audit-level=high\` | 2026-08-08 | abc123 | Clean |
| pip-audit | N/A | 2026-08-08 | abc123 | N/A — no Python tooling in repo |

${sections}

## 8. Open findings summary

No open findings.

## 9. Re-run checklist

- [ ] re-run bun audit
`;
}

describe("check-owasp-review.mjs — tester-supplement edge cases", () => {
  it("does not treat the section-2 scan-results table as a findings table (its header is 'Scan', not 'ID')", () => {
    // fullDoc() always includes the section-2 "Scan | Command | ..." table
    // before any category section. If the parser mistakenly grabbed the
    // first table it saw regardless of header, this would misparse.
    const fixturePath = writeFixture(fullDoc());

    const result = runCheck([fixturePath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK:");
    // 5 categories x 1 row each = 5 findings, none blocking.
    expect(result.stdout).toContain("5 findings, 0 blocking");
  });

  it("does not treat a '### ' sub-heading as ending the enclosing '## ' section", () => {
    // categorySection() interleaves "### Scope reviewed" / "### Method" /
    // "### Findings" / "### Conclusion" sub-headings around the table,
    // exactly like the real doc. If sub-headings terminated a section, the
    // parser would fail to find the findings table (it comes after two
    // "### " headings).
    const fixturePath = writeFixture(fullDoc());

    const result = runCheck([fixturePath]);

    expect(result.status).toBe(0);
  });

  it("correctly parses a row containing an escaped pipe ('\\|') inside a cell without miscounting columns", () => {
    const row =
      '| A03-1 | Info | Resolved | Command used: `grep -rn "\\.query(\\|sql\\`" app lib` | app/**, lib/** | No matches found. |';
    const fixturePath = writeFixture(fullDoc({ A03: row }));

    const result = runCheck([fixturePath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK:");
  });

  it("exits 1 with an unexpected-column-count message for a row missing a cell", () => {
    const row = "| A02-1 | High | Deferred | Missing a cell | some/file.ts |"; // 5 cells, not 6
    const fixturePath = writeFixture(fullDoc({ A02: row }));

    const result = runCheck([fixturePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A02");
    expect(result.stderr.toLowerCase()).toMatch(/column/);
  });

  it("exits 1 when a finding's ID does not start with its enclosing section's category prefix", () => {
    const row =
      "| A02-3 | Info | Resolved | Wrong prefix, lives in the A01 section | some/file.ts | n/a |";
    const fixturePath = writeFixture(fullDoc({ A01: row }));

    const result = runCheck([fixturePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A02-3");
  });

  it("FAILURE CASE: exits 1 and names the finding for a Critical + Open row (the most severe blocking case)", () => {
    const row =
      "| A05-9 | Critical | Open | Unpatched critical vulnerability | some/file.ts | Not yet triaged. |";
    const fixturePath = writeFixture(fullDoc({ A05: row }));

    const result = runCheck([fixturePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A05-9");
    expect(result.stderr).toContain("Critical");
    expect(result.stderr).toContain("Open");
  });

  it("exits 1 for a doc that is present but empty", () => {
    const fixturePath = writeFixture("");

    const result = runCheck([fixturePath]);

    expect(result.status).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("empty");
  });

  it("resolves the default doc path from the script's own location, not from cwd", () => {
    // Run the script with a cwd that is NOT the repo root, and no path arg,
    // to confirm it still finds documentation/owasp-top-10-review.md via
    // fileURLToPath(import.meta.url) rather than process.cwd().
    const result = spawnSync("node", [SCRIPT_PATH], {
      encoding: "utf8",
      cwd: os.tmpdir(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK:");
  });
});
