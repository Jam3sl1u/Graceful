import "server-only";

// TODO(Sprint 3 #49): generate pre-signed Cloudflare R2 (S3-compatible)
// upload/download URLs, 30-minute expiry, only after verifying auth + church
// group membership (PRD §19.2). Uses R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /
// R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME / R2_ENDPOINT.
export async function getUploadUrl(_key: string): Promise<string> {
  throw new Error("getUploadUrl not implemented — see Sprint 3 #49");
}

export async function getDownloadUrl(_key: string): Promise<string> {
  throw new Error("getDownloadUrl not implemented — see Sprint 3 #49");
}
