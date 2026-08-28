import { evaluateThreshold, percentile, summarize } from "@/tests/load/stats";
import { LOAD_PROFILE } from "@/tests/load/targets";

describe("percentile", () => {
  it("returns null for an empty sample set", () => {
    expect(percentile([], 95)).toBeNull();
  });

  it("returns the single value for a one-element sample set at any percentile", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it("computes nearest-rank p50/p95/p99 on an unsorted sample set", () => {
    // 1..100 ascending; nearest-rank: index = clamp(ceil(p/100*n)-1, 0, n-1)
    const samples = Array.from({ length: 100 }, (_, i) => 100 - i); // 100..1 descending
    expect(percentile(samples, 50)).toBe(50);
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile(samples, 99)).toBe(99);
  });

  it("does not mutate the input array", () => {
    const samples = [5, 3, 1, 4, 2];
    const copy = [...samples];
    percentile(samples, 95);
    expect(samples).toEqual(copy);
  });
});

describe("summarize", () => {
  it("returns null for an empty sample set", () => {
    expect(summarize([])).toBeNull();
  });

  it("computes count/min/max/mean plus percentiles", () => {
    const summary = summarize([10, 20, 30, 40, 50]);
    expect(summary).not.toBeNull();
    expect(summary?.count).toBe(5);
    expect(summary?.min).toBe(10);
    expect(summary?.max).toBe(50);
    expect(summary?.mean).toBe(30);
    expect(summary?.p50).toBe(30);
  });
});

describe("evaluateThreshold", () => {
  it("fails with a stated reason when summary is null (zero successful samples)", () => {
    const result = evaluateThreshold(null, 500, { ok: 0, rateLimited: 0, errors: 5 });
    expect(result.status).toBe("fail");
    expect(result.p95).toBeNull();
    if (result.status === "fail") {
      expect(result.reason).toMatch(/no successful samples/);
    }
  });

  it("passes when p95 is under the threshold and error rate is within budget", () => {
    const summary = summarize([100, 150, 200, 250, 300]);
    const result = evaluateThreshold(summary, 500, { ok: 5, rateLimited: 0, errors: 0 });
    expect(result.status).toBe("pass");
    if (result.status === "pass") {
      expect(result.p95).toBe(summary?.p95);
    }
  });

  it("fails when p95 exceeds the threshold, regardless of error rate", () => {
    const summary = summarize([600, 650, 700]);
    const result = evaluateThreshold(summary, 500, { ok: 3, rateLimited: 0, errors: 0 });
    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.reason).toMatch(/exceeds threshold/);
    }
  });

  it("fails when the non-429 error rate exceeds maxErrorRate, even with a good p95", () => {
    const summary = summarize([100, 100]);
    // 2 errors / 100 total = 2% > default 1% maxErrorRate
    const result = evaluateThreshold(summary, 500, { ok: 98, rateLimited: 0, errors: 2 });
    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.reason).toMatch(/error rate/);
    }
  });

  it("excludes rateLimited from the error-rate denominator", () => {
    const summary = summarize([100, 100]);
    // Without excluding rateLimited, 500 rate-limited responses would dwarf
    // the error rate; since they're excluded, only ok/errors count.
    const result = evaluateThreshold(summary, 500, { ok: 99, rateLimited: 500, errors: 1 });
    expect(result.status).toBe("pass");
  });

  it("respects an explicit maxErrorRate override", () => {
    const summary = summarize([100, 100]);
    const result = evaluateThreshold(summary, 500, { ok: 90, rateLimited: 0, errors: 10 }, 0.5);
    expect(result.status).toBe("pass");
  });

  it("defaults maxErrorRate to LOAD_PROFILE.maxErrorRate", () => {
    const summary = summarize([100, 100]);
    const atLimit = LOAD_PROFILE.maxErrorRate;
    // exactly at the limit should still pass (fails only when strictly greater)
    const errors = Math.round(atLimit * 100);
    const result = evaluateThreshold(summary, 500, { ok: 100 - errors, rateLimited: 0, errors });
    expect(result.status).toBe("pass");
  });
});
