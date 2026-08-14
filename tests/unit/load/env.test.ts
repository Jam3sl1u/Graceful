import { readEnv } from "@/tests/load/env";

describe("readEnv", () => {
  it("returns unconfigured when no load-test env vars are set at all", () => {
    const result = readEnv({} as unknown as NodeJS.ProcessEnv);
    expect(result.kind).toBe("unconfigured");
  });

  it("returns configured with a fully populated config (happy path)", () => {
    const result = readEnv({
      LOAD_TEST_BASE_URL: "https://staging.example.com",
      LOAD_TEST_ADMIN_TOKENS: "admin-1, admin-2",
      LOAD_TEST_MEMBER_TOKENS: "member-1",
      LOAD_TEST_SONG_ID: "song-123",
    } as unknown as NodeJS.ProcessEnv);

    expect(result.kind).toBe("configured");
    if (result.kind === "configured") {
      expect(result.config).toEqual({
        baseUrl: "https://staging.example.com",
        adminTokens: ["admin-1", "admin-2"],
        memberTokens: ["member-1"],
        songId: "song-123",
      });
    }
  });

  it("returns unconfigured (not partial) when only STAGING_APP_URL is set (regression: issue #81 review SHOULD FIX)", () => {
    // STAGING_APP_URL is a general-purpose var set in most environments for
    // reasons unrelated to load testing; its mere presence must not turn an
    // otherwise-unconfigured harness into exit code 2 (partial) instead of
    // the documented exit code 0 (unconfigured, skip).
    const result = readEnv({
      STAGING_APP_URL: "https://staging.example.com",
    } as unknown as NodeJS.ProcessEnv);

    expect(result.kind).toBe("unconfigured");
  });

  it("falls back to STAGING_APP_URL when LOAD_TEST_BASE_URL is unset", () => {
    const result = readEnv({
      STAGING_APP_URL: "https://staging.example.com",
      LOAD_TEST_ADMIN_TOKENS: "admin-1",
      LOAD_TEST_MEMBER_TOKENS: "member-1",
    } as unknown as NodeJS.ProcessEnv);

    expect(result.kind).toBe("configured");
    if (result.kind === "configured") {
      expect(result.config.baseUrl).toBe("https://staging.example.com");
    }
  });

  it("strips a trailing slash (or multiple) from the base URL", () => {
    const result = readEnv({
      LOAD_TEST_BASE_URL: "https://staging.example.com///",
      LOAD_TEST_ADMIN_TOKENS: "admin-1",
      LOAD_TEST_MEMBER_TOKENS: "member-1",
    } as unknown as NodeJS.ProcessEnv);

    expect(result.kind).toBe("configured");
    if (result.kind === "configured") {
      expect(result.config.baseUrl).toBe("https://staging.example.com");
    }
  });

  it("returns songId: null when LOAD_TEST_SONG_ID is unset", () => {
    const result = readEnv({
      LOAD_TEST_BASE_URL: "https://staging.example.com",
      LOAD_TEST_ADMIN_TOKENS: "admin-1",
      LOAD_TEST_MEMBER_TOKENS: "member-1",
    } as unknown as NodeJS.ProcessEnv);

    expect(result.kind).toBe("configured");
    if (result.kind === "configured") {
      expect(result.config.songId).toBeNull();
    }
  });

  it("splits comma-separated token lists, trimming whitespace and dropping empties", () => {
    const result = readEnv({
      LOAD_TEST_BASE_URL: "https://staging.example.com",
      LOAD_TEST_ADMIN_TOKENS: " admin-1 ,, admin-2 ,admin-3,",
      LOAD_TEST_MEMBER_TOKENS: "member-1",
    } as unknown as NodeJS.ProcessEnv);

    expect(result.kind).toBe("configured");
    if (result.kind === "configured") {
      expect(result.config.adminTokens).toEqual(["admin-1", "admin-2", "admin-3"]);
    }
  });

  it("returns partial with the list of missing vars when some but not all are set", () => {
    const result = readEnv({
      LOAD_TEST_BASE_URL: "https://staging.example.com",
    } as unknown as NodeJS.ProcessEnv);

    expect(result.kind).toBe("partial");
    if (result.kind === "partial") {
      expect(result.missing).toEqual(
        expect.arrayContaining(["LOAD_TEST_ADMIN_TOKENS", "LOAD_TEST_MEMBER_TOKENS"]),
      );
      expect(result.missing).not.toContain("LOAD_TEST_BASE_URL");
    }
  });

  it("treats a token list of only whitespace/commas as empty ⇒ partial (failure case)", () => {
    const result = readEnv({
      LOAD_TEST_BASE_URL: "https://staging.example.com",
      LOAD_TEST_ADMIN_TOKENS: " , , ",
      LOAD_TEST_MEMBER_TOKENS: "member-1",
    } as unknown as NodeJS.ProcessEnv);

    expect(result.kind).toBe("partial");
    if (result.kind === "partial") {
      expect(result.missing).toContain("LOAD_TEST_ADMIN_TOKENS");
    }
  });

  it("treats an env carrying only the optional LOAD_TEST_SONG_ID as partial, not unconfigured", () => {
    const result = readEnv({
      LOAD_TEST_SONG_ID: "song-123",
    } as unknown as NodeJS.ProcessEnv);

    expect(result.kind).toBe("partial");
  });

  it("never echoes a token value back in the partial-env missing list", () => {
    const result = readEnv({
      LOAD_TEST_BASE_URL: "https://staging.example.com",
      LOAD_TEST_ADMIN_TOKENS: "super-secret-jwt-value",
    } as unknown as NodeJS.ProcessEnv);

    expect(result.kind).toBe("partial");
    if (result.kind === "partial") {
      expect(JSON.stringify(result.missing)).not.toContain("super-secret-jwt-value");
    }
  });
});
