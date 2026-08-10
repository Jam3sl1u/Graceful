/**
 * Independent coverage for tests/load/scenarios.ts's non-load-profile logic
 * (preflight, the always-blocked notification scenario, the signed-url
 * early-skip path, and the rate-limit probe). runApiLoad/runSignedUrlLoad's
 * actual load path is intentionally NOT exercised here: it hardcodes
 * LOAD_PROFILE's real 60s duration + 10s ramp-up via runConcurrent's default
 * (non-injectable) `now`/`sleep`, so a real pass takes 70+ seconds of real
 * wall-clock time even with a mocked fetch — that's why the coder's spec
 * left tests/load/scenarios.ts out of the unit suite and relies on a real
 * `bun run test:load` pass instead. See .pipeline/test-results.md.
 */
import {
  preflight,
  runNotificationLatency,
  runRateLimitProbe,
  runSignedUrlLoad,
} from "@/tests/load/scenarios";
import { EXPECTED_RATE_LIMIT_POLICIES } from "@/tests/load/targets";
import type { LoadTestConfig } from "@/tests/load/env";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function baseConfig(overrides: Partial<LoadTestConfig> = {}): LoadTestConfig {
  return {
    baseUrl: "https://staging.example.test",
    adminTokens: ["admin-token"],
    memberTokens: ["member-token"],
    songId: null,
    ...overrides,
  };
}

describe("preflight", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("succeeds (happy path) when every endpoint responds 2xx", async () => {
    // mockImplementation (not mockResolvedValue) so each of the 12 calls gets
    // its own Response instance — a Response body can only be read once, and
    // preflight() calls fetch once per API_ENDPOINTS entry.
    global.fetch = jest.fn(async () => jsonResponse(200, { data: {} })) as unknown as typeof fetch;
    const result = await preflight(baseConfig());
    expect(result.ok).toBe(true);
  });

  it("reports a named failure entry for a non-2xx endpoint", async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (new URL(url).pathname === "/api/instruments") {
        return jsonResponse(500, { error: "boom", code: "INTERNAL" });
      }
      return jsonResponse(200, { data: {} });
    }) as unknown as typeof fetch;

    const result = await preflight(baseConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toEqual(["GET /api/instruments: HTTP 500"]);
    }
  });

  it("retries a single 429 after Retry-After before treating it as a failure", async () => {
    let healthCalls = 0;
    global.fetch = jest.fn(async (url: string) => {
      if (new URL(url).pathname === "/api/health") {
        healthCalls += 1;
        if (healthCalls === 1) {
          return jsonResponse(
            429,
            { error: "slow down", code: "RATE_LIMITED" },
            { "Retry-After": "0" },
          );
        }
      }
      return jsonResponse(200, { data: {} });
    }) as unknown as typeof fetch;

    const result = await preflight(baseConfig());
    expect(healthCalls).toBe(2);
    expect(result.ok).toBe(true);
  }, 10_000);

  it("also probes the signed-url endpoint when songId is set, using its own request", async () => {
    const seenPaths: string[] = [];
    global.fetch = jest.fn(async (url: string) => {
      seenPaths.push(new URL(url).pathname);
      return jsonResponse(200, { data: {} });
    }) as unknown as typeof fetch;

    await preflight(baseConfig({ songId: "song-abc" }));
    expect(seenPaths).toContain("/api/songs/song-abc/documents");
  });

  it("does not probe the signed-url endpoint when songId is null", async () => {
    const seenPaths: string[] = [];
    global.fetch = jest.fn(async (url: string) => {
      seenPaths.push(new URL(url).pathname);
      return jsonResponse(200, { data: {} });
    }) as unknown as typeof fetch;

    await preflight(baseConfig({ songId: null }));
    expect(seenPaths.some((p) => p.includes("/documents"))).toBe(false);
  });
});

describe("runNotificationLatency", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("always returns blocked with no network calls and no fabricated measurement", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await runNotificationLatency();

    expect(result.status).toBe("blocked");
    expect(result.measured).toBe("—");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.detail).toMatch(/lib\/pingram\/client\.ts/);
    expect(result.detail).toMatch(/lib\/resend\/client\.ts/);
  });
});

describe("runSignedUrlLoad — skipped path", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("returns skipped with no network calls when songId is null (edge case)", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await runSignedUrlLoad(baseConfig({ songId: null }));

    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("runRateLimitProbe", () => {
  const originalFetch = global.fetch;
  const policy = EXPECTED_RATE_LIMIT_POLICIES.read;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("passes (happy path) when every /api/profile request comes back 429 with a valid Retry-After and RATE_LIMITED code", async () => {
    // mockImplementation, not mockResolvedValue: a Response body can only be
    // read once, and this scenario issues many sequential requests.
    const fetchMock = jest.fn(async () =>
      jsonResponse(429, { error: "slow down", code: "RATE_LIMITED" }, { "Retry-After": "5" }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await runRateLimitProbe(baseConfig());

    expect(result.status).toBe("pass");
    expect(result.measured).toBe(`${policy.limit} 429s`);
    // Short-circuits at policy.limit once already satisfiable — never issues
    // the full limit + 20 requests.
    expect(fetchMock).toHaveBeenCalledTimes(policy.limit);
  });

  it("fails (failure case) when no 429 is ever observed", async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, { data: {} })) as unknown as typeof fetch;

    const result = await runRateLimitProbe(baseConfig());

    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/no 429 observed/);
  });

  it("fails when a 429 is observed but is missing a valid Retry-After header", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse(
        429,
        { error: "slow down", code: "RATE_LIMITED" },
        { "Retry-After": "not-a-number" },
      ),
    ) as unknown as typeof fetch;

    const result = await runRateLimitProbe(baseConfig());

    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/Retry-After/);
  });

  it("fails when a 429 body does not report code === RATE_LIMITED", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse(429, { error: "slow down", code: "SOMETHING_ELSE" }, { "Retry-After": "5" }),
    ) as unknown as typeof fetch;

    const result = await runRateLimitProbe(baseConfig());

    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/RATE_LIMITED/);
  });

  it("never leaks the bearer token into the scenario detail string", async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, { data: {} })) as unknown as typeof fetch;

    const result = await runRateLimitProbe(
      baseConfig({ memberTokens: ["super-secret-member-jwt"] }),
    );

    expect(result.detail).not.toContain("super-secret-member-jwt");
    expect(result.measured).not.toContain("super-secret-member-jwt");
  });
});
