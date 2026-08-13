import {
  API_ENDPOINTS,
  EXPECTED_RATE_LIMIT_POLICIES,
  LOAD_PROFILE,
  NOTIFICATION_PROFILE,
  PERF_TARGETS,
} from "@/tests/load/targets";
import { RATE_LIMIT_POLICIES } from "@/lib/api/rate-limit";

describe("PERF_TARGETS", () => {
  it("has the AC-mandated thresholds", () => {
    expect(PERF_TARGETS.api.thresholdMs).toBe(500);
    expect(PERF_TARGETS.signedUrl.thresholdMs).toBe(200);
    expect(PERF_TARGETS.sms.thresholdMs).toBe(30_000);
    expect(PERF_TARGETS.email.thresholdMs).toBe(60_000);
  });

  it("every target's id matches its own key", () => {
    for (const [key, target] of Object.entries(PERF_TARGETS)) {
      expect(target.id).toBe(key);
    }
  });
});

describe("LOAD_PROFILE / NOTIFICATION_PROFILE", () => {
  it("matches the spec'd load profile", () => {
    expect(LOAD_PROFILE).toEqual({
      concurrentUsers: 100,
      durationSeconds: 60,
      rampUpSeconds: 10,
      requestTimeoutMs: 30_000,
      maxErrorRate: 0.01,
      thinkTimeMs: 500,
    });
  });

  it("matches the spec'd notification profile", () => {
    expect(NOTIFICATION_PROFILE).toEqual({ simultaneousSends: 50 });
  });
});

describe("API_ENDPOINTS", () => {
  it("contains no forbidden not-implemented routes", () => {
    const forbidden = [
      "/api/church-group",
      "/api/notifications",
      "/api/notifications/unread-count",
    ];
    const paths = API_ENDPOINTS.map((e) => e.path);
    for (const bad of forbidden) {
      expect(paths).not.toContain(bad);
    }
    expect(paths.some((p) => p.startsWith("/api/webhooks/"))).toBe(false);
  });

  it("every entry is a GET with a non-empty name and path", () => {
    for (const endpoint of API_ENDPOINTS) {
      expect(endpoint.method).toBe("GET");
      expect(endpoint.name.length).toBeGreaterThan(0);
      expect(endpoint.path.startsWith("/api/")).toBe(true);
      expect(["none", "member", "admin"]).toContain(endpoint.persona);
    }
  });

  it("has no duplicate paths", () => {
    const paths = API_ENDPOINTS.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("EXPECTED_RATE_LIMIT_POLICIES sync check", () => {
  it("mirrors lib/api/rate-limit.ts's RATE_LIMIT_POLICIES exactly", () => {
    expect(EXPECTED_RATE_LIMIT_POLICIES).toEqual(RATE_LIMIT_POLICIES);
  });
});
