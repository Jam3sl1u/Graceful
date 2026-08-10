import { renderMarkdown, resolveExitCode } from "@/tests/load/report";
import type { ScenarioResult } from "@/tests/load/scenarios";

function makeResult(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    id: "api",
    label: "API load",
    targetLabel: "p95 < 500ms",
    status: "pass",
    measured: "412ms",
    detail: "100 ok, 0 rate-limited, 0 errors",
    ...overrides,
  };
}

describe("renderMarkdown", () => {
  it("renders a header row and one row per result", () => {
    const md = renderMarkdown([makeResult()], {
      baseUrl: "https://staging.example.com",
      startedAt: "2026-08-10T00:00:00.000Z",
    });
    expect(md).toContain("| Target | Threshold | Measured (p95) | Status | Notes |");
    expect(md).toContain(
      "| API load | p95 < 500ms | 412ms | Pass | 100 ok, 0 rate-limited, 0 errors |",
    );
  });

  it("maps every ScenarioStatus to the spec'd cell value", () => {
    const md = renderMarkdown(
      [
        makeResult({ id: "api", status: "pass" }),
        makeResult({ id: "signed-url", status: "fail" }),
        makeResult({ id: "notifications", status: "blocked" }),
        makeResult({ id: "rate-limit", status: "skipped" }),
      ],
      { baseUrl: "https://staging.example.com", startedAt: "2026-08-10T00:00:00.000Z" },
    );
    expect(md).toContain("| Pass |");
    expect(md).toContain("| Fail |");
    expect(md).toContain("| Blocked |");
    expect(md).toContain("| Not run |");
  });

  it("prints the base URL host-only, with no query string or credentials", () => {
    const md = renderMarkdown([makeResult()], {
      baseUrl: "https://user:pass@staging.example.com/some/path?token=abc123",
      startedAt: "2026-08-10T00:00:00.000Z",
    });
    expect(md).not.toContain("token=abc123");
    expect(md).not.toContain("user:pass");
    expect(md).toContain("staging.example.com");
  });

  it("escapes pipe characters in notes so they don't break the table", () => {
    const md = renderMarkdown([makeResult({ detail: "a | b" })], {
      baseUrl: "https://staging.example.com",
      startedAt: "2026-08-10T00:00:00.000Z",
    });
    expect(md).toContain("a \\| b");
  });
});

describe("resolveExitCode", () => {
  it("returns 0 when every result passed", () => {
    expect(resolveExitCode([makeResult({ status: "pass" }), makeResult({ status: "pass" })])).toBe(
      0,
    );
  });

  it("returns 1 when at least one result failed, even if others are skipped/blocked", () => {
    expect(
      resolveExitCode([
        makeResult({ status: "fail" }),
        makeResult({ status: "skipped" }),
        makeResult({ status: "pass" }),
      ]),
    ).toBe(1);
  });

  it("returns 3 when there are no failures but at least one skipped result", () => {
    expect(
      resolveExitCode([makeResult({ status: "pass" }), makeResult({ status: "skipped" })]),
    ).toBe(3);
  });

  it("returns 3 when there are no failures but at least one blocked result", () => {
    expect(
      resolveExitCode([makeResult({ status: "pass" }), makeResult({ status: "blocked" })]),
    ).toBe(3);
  });

  it("returns 0 for an empty result list", () => {
    expect(resolveExitCode([])).toBe(0);
  });
});
