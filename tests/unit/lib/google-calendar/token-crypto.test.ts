// Tests for lib/google-calendar/token-crypto.ts (AES-256-GCM at-rest
// encryption for Google OAuth tokens, PRD §25.5).

import { randomBytes } from "crypto";
import { encryptToken, decryptToken } from "@/lib/google-calendar/token-crypto";

const VALID_KEY = randomBytes(32).toString("base64");

describe("lib/google-calendar/token-crypto", () => {
  const originalEnv = process.env.TOKEN_ENCRYPTION_KEY;

  afterEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = originalEnv;
  });

  describe("round trip", () => {
    beforeEach(() => {
      process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
    });

    it("decrypts to the original plaintext", () => {
      const plaintext = "ya29.a0AfH6SMB_example_access_token";
      const ciphertext = encryptToken(plaintext);
      expect(decryptToken(ciphertext)).toBe(plaintext);
    });

    it("produces a distinct ciphertext (distinct IV) for two encryptions of the same input", () => {
      const plaintext = "1//0g_example_refresh_token";
      const a = encryptToken(plaintext);
      const b = encryptToken(plaintext);
      expect(a).not.toBe(b);

      // Both still decrypt correctly despite differing IVs.
      expect(decryptToken(a)).toBe(plaintext);
      expect(decryptToken(b)).toBe(plaintext);
    });

    it("never leaks the plaintext or key into the ciphertext string", () => {
      const plaintext = "super-secret-token-value";
      const ciphertext = encryptToken(plaintext);
      expect(ciphertext).not.toContain(plaintext);
      expect(ciphertext).not.toContain(VALID_KEY);
    });

    it("throws on tampered ciphertext (auth tag mismatch)", () => {
      const ciphertext = encryptToken("some-token");
      const [iv, authTag, data] = ciphertext.split(":") as [string, string, string];
      const tamperedData = Buffer.from(data, "base64");
      tamperedData[0] = (tamperedData[0] ?? 0) ^ 0xff;
      const tampered = [iv, authTag, tamperedData.toString("base64")].join(":");

      expect(() => decryptToken(tampered)).toThrow();
    });

    it("throws on a malformed ciphertext string", () => {
      expect(() => decryptToken("not-a-valid-ciphertext")).toThrow();
    });
  });

  describe("key validation", () => {
    it("throws when TOKEN_ENCRYPTION_KEY is unset", () => {
      delete process.env.TOKEN_ENCRYPTION_KEY;
      expect(() => encryptToken("x")).toThrow();
    });

    it("throws when TOKEN_ENCRYPTION_KEY does not decode to 32 bytes", () => {
      process.env.TOKEN_ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
      expect(() => encryptToken("x")).toThrow();
    });

    it("never includes the key value in the thrown error message", () => {
      const badKey = Buffer.from("too-short").toString("base64");
      process.env.TOKEN_ENCRYPTION_KEY = badKey;
      try {
        encryptToken("x");
        throw new Error("expected encryptToken to throw");
      } catch (err) {
        expect((err as Error).message).not.toContain(badKey);
      }
    });
  });
});
