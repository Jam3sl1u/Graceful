import { runConcurrent, timedRequest } from "@/tests/load/http";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("timedRequest", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("classifies 2xx/3xx as ok", async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { data: {} }));
    const outcome = await timedRequest("https://example.test/api/health", {
      method: "GET",
      token: null,
      timeoutMs: 1000,
    });
    expect(outcome.classification).toBe("ok");
    expect(outcome.status).toBe(200);
    expect(outcome.errorCode).toBeNull();
    expect(outcome.retryAfter).toBeNull();
  });

  it("classifies 429 as rateLimited and captures Retry-After", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(
          429,
          { error: "Rate limit exceeded", code: "RATE_LIMITED" },
          { "Retry-After": "5" },
        ),
      );
    const outcome = await timedRequest("https://example.test/api/profile", {
      method: "GET",
      token: "tok",
      timeoutMs: 1000,
    });
    expect(outcome.classification).toBe("rateLimited");
    expect(outcome.retryAfter).toBe("5");
    expect(outcome.errorCode).toBe("RATE_LIMITED");
  });

  it("classifies 401 and 403 as unauthorized", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: "nope", code: "UNAUTHENTICATED" }));
    const outcome401 = await timedRequest("https://example.test/api/profile", {
      method: "GET",
      token: null,
      timeoutMs: 1000,
    });
    expect(outcome401.classification).toBe("unauthorized");

    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(403, { error: "nope", code: "FORBIDDEN" }));
    const outcome403 = await timedRequest("https://example.test/api/profile", {
      method: "GET",
      token: "tok",
      timeoutMs: 1000,
    });
    expect(outcome403.classification).toBe("unauthorized");
  });

  it("classifies 500 as error and parses the ApiError code best-effort", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(500, { error: "boom", code: "INTERNAL" }));
    const outcome = await timedRequest("https://example.test/api/songs", {
      method: "GET",
      token: "tok",
      timeoutMs: 1000,
    });
    expect(outcome.classification).toBe("error");
    expect(outcome.errorCode).toBe("INTERNAL");
  });

  it("classifies a thrown/aborted request as error with status 0 and no thrown durationMs", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));
    const outcome = await timedRequest("https://example.test/api/health", {
      method: "GET",
      token: null,
      timeoutMs: 1000,
    });
    expect(outcome.status).toBe(0);
    expect(outcome.classification).toBe("error");
    expect(outcome.errorCode).toBeNull();
    expect(typeof outcome.durationMs).toBe("number");
  });

  it("sends the token as an Authorization Bearer header when provided", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: {} }));
    global.fetch = fetchMock;
    await timedRequest("https://example.test/api/profile", {
      method: "GET",
      token: "secret-token",
      timeoutMs: 1000,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe("Bearer secret-token");
  });

  it("sends no Authorization header when token is null", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: {} }));
    global.fetch = fetchMock;
    await timedRequest("https://example.test/api/health", {
      method: "GET",
      token: null,
      timeoutMs: 1000,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBeUndefined();
  });
});

describe("runConcurrent", () => {
  it("never exceeds the concurrency ceiling", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await runConcurrent(
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      },
      { concurrency: 5, iterationsPerWorker: 4 },
    );

    // Exactly 5, not merely "at most 5": with concurrency 5 and no ramp-up
    // stagger, all 5 workers' first iteration increments inFlight
    // synchronously (Array.from invokes each async worker callback
    // synchronously up to its first await) before any 1ms setTimeout can
    // fire, so reaching 5 is deterministic. A regression to a serial (or
    // otherwise under-concurrent) implementation would still satisfy
    // `toBeLessThanOrEqual(5)` but fails this.
    expect(maxInFlight).toBe(5);
  });

  it("runs exactly concurrency * iterationsPerWorker tasks when iterationsPerWorker is set", async () => {
    const calls: { workerIndex: number; iteration: number }[] = [];
    await runConcurrent(
      async (workerIndex, iteration) => {
        calls.push({ workerIndex, iteration });
      },
      { concurrency: 3, iterationsPerWorker: 2 },
    );
    expect(calls).toHaveLength(6);
  });

  it("stops issuing new iterations once the injected clock passes the duration deadline", async () => {
    let now = 0;
    const clock = () => now;
    const calls: number[] = [];

    await runConcurrent(
      async (workerIndex) => {
        calls.push(workerIndex);
        now += 10; // advance the injected clock by 10ms per call
      },
      { concurrency: 2, durationMs: 25, now: clock, sleep: async () => {} },
    );

    // Each worker's loop checks now() < deadline before each iteration; with
    // a shared clock advancing 10ms per call, this terminates quickly and
    // deterministically rather than depending on real wall-clock time.
    // worker0 sees deadline=25 (computed when now=0); worker1 starts after
    // worker0's first call already advanced the clock to 10, so it sees
    // deadline=35. Pinning the exact interleaving (not just "ran at least
    // once") catches regressions to the termination/interleaving logic.
    expect(calls).toEqual([0, 1, 0, 1]);
  });

  it("throws when both durationMs and iterationsPerWorker are provided", async () => {
    await expect(
      runConcurrent(async () => {}, { concurrency: 1, durationMs: 10, iterationsPerWorker: 1 }),
    ).rejects.toThrow(/exactly one of durationMs or iterationsPerWorker/);
  });

  it("throws when neither durationMs nor iterationsPerWorker are provided", async () => {
    await expect(runConcurrent(async () => {}, { concurrency: 1 })).rejects.toThrow(
      /exactly one of durationMs or iterationsPerWorker/,
    );
  });

  it("staggers worker start times across rampUpMs using the injected sleep", async () => {
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    await runConcurrent(async () => {}, {
      concurrency: 3,
      rampUpMs: 100,
      iterationsPerWorker: 1,
      sleep,
    });

    // 3 workers, rampUpMs 100 => stagger = 100 / (3 - 1) = 50ms; worker 0
    // does not sleep (delay 0), so only 2 sleep calls are recorded.
    expect(sleepCalls.sort((a, b) => a - b)).toEqual([50, 100]);
  });

  it("paces iterations with thinkTimeMs via the injected sleep, in duration mode", async () => {
    let now = 0;
    const clock = () => now;
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };
    const calls: number[] = [];

    await runConcurrent(
      async (workerIndex) => {
        calls.push(workerIndex);
        now += 1;
      },
      { concurrency: 1, durationMs: 3, thinkTimeMs: 10, now: clock, sleep },
    );

    expect(calls.length).toBeGreaterThan(0);
    expect(sleepCalls).toEqual(calls.map(() => 10));
  });

  it("never sleeps for think-time when thinkTimeMs is omitted", async () => {
    let now = 0;
    const clock = () => now;
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    await runConcurrent(
      async () => {
        now += 1;
      },
      { concurrency: 1, durationMs: 3, now: clock, sleep },
    );

    expect(sleepCalls).toEqual([]);
  });
});
