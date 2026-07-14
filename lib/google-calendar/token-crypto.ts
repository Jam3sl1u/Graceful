import "server-only";

// TODO(Sprint 3 #61): AES-256 encrypt/decrypt Google OAuth tokens at rest
// using TOKEN_ENCRYPTION_KEY (PRD §25.5).
export function encryptToken(_plaintext: string): string {
  throw new Error("encryptToken not implemented — see Sprint 3 #61");
}

export function decryptToken(_ciphertext: string): string {
  throw new Error("decryptToken not implemented — see Sprint 3 #61");
}
