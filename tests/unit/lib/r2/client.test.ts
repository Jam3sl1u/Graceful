jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation((config: unknown) => ({ config })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: "Put", input })),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: "Get", input })),
}));
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(),
}));

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const mockS3Client = S3Client as unknown as jest.Mock;
const mockPutObjectCommand = PutObjectCommand as unknown as jest.Mock;
const mockGetObjectCommand = GetObjectCommand as unknown as jest.Mock;
const mockGetSignedUrl = getSignedUrl as unknown as jest.Mock;

const ENV_KEYS = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"] as const;
const VALID_ENV = {
  R2_ENDPOINT: "https://r2.example.com",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "secret-key",
  R2_BUCKET_NAME: "song-documents-bucket",
};

function setValidEnv() {
  for (const key of ENV_KEYS) {
    process.env[key] = VALID_ENV[key];
  }
}

function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

// The module holds a lazy-singleton S3Client at module scope, so every test
// re-imports it fresh (via resetModules + require) to observe construction
// behavior and env-var validation in isolation.
async function importFreshClient() {
  let mod: typeof import("@/lib/r2/client");
  await jest.isolateModulesAsync(async () => {
    mod = await import("@/lib/r2/client");
  });
  return mod!;
}

describe("lib/r2/client", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearEnv();
    mockS3Client.mockClear();
    mockPutObjectCommand.mockClear();
    mockGetObjectCommand.mockClear();
    mockGetSignedUrl.mockReset();
    mockGetSignedUrl.mockResolvedValue("https://r2.example.com/signed-url");
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("getUploadUrl", () => {
    it("signs a PutObjectCommand with the bucket, key, content type, and 30-minute expiry", async () => {
      setValidEnv();
      const { getUploadUrl } = await importFreshClient();

      const url = await getUploadUrl("song-documents/group-1/song-1/uuid/Chart.pdf", "application/pdf");

      expect(url).toBe("https://r2.example.com/signed-url");
      expect(mockPutObjectCommand).toHaveBeenCalledWith({
        Bucket: VALID_ENV.R2_BUCKET_NAME,
        Key: "song-documents/group-1/song-1/uuid/Chart.pdf",
        ContentType: "application/pdf",
      });
      const [, , options] = mockGetSignedUrl.mock.calls[0];
      expect(options).toEqual({ expiresIn: 30 * 60 });
    });

    it("works without a contentType (optional param)", async () => {
      setValidEnv();
      const { getUploadUrl } = await importFreshClient();

      await getUploadUrl("song-documents/group-1/song-1/uuid/Chart.pdf");

      expect(mockPutObjectCommand).toHaveBeenCalledWith({
        Bucket: VALID_ENV.R2_BUCKET_NAME,
        Key: "song-documents/group-1/song-1/uuid/Chart.pdf",
        ContentType: undefined,
      });
    });

    it.each(ENV_KEYS)("throws when %s is missing", async (missingKey) => {
      setValidEnv();
      delete process.env[missingKey];
      const { getUploadUrl } = await importFreshClient();

      await expect(getUploadUrl("some/key", "application/pdf")).rejects.toThrow(
        /R2 is not configured/,
      );
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it.each(ENV_KEYS)("throws when %s is present but an empty string", async (emptyKey) => {
      setValidEnv();
      process.env[emptyKey] = "";
      const { getUploadUrl } = await importFreshClient();

      await expect(getUploadUrl("some/key", "application/pdf")).rejects.toThrow(
        /R2 is not configured/,
      );
    });
  });

  describe("getDownloadUrl", () => {
    it("signs a GetObjectCommand with the bucket, key, and 30-minute expiry", async () => {
      setValidEnv();
      const { getDownloadUrl } = await importFreshClient();

      const url = await getDownloadUrl("song-documents/group-1/song-1/uuid/Chart.pdf");

      expect(url).toBe("https://r2.example.com/signed-url");
      expect(mockGetObjectCommand).toHaveBeenCalledWith({
        Bucket: VALID_ENV.R2_BUCKET_NAME,
        Key: "song-documents/group-1/song-1/uuid/Chart.pdf",
      });
      const [, , options] = mockGetSignedUrl.mock.calls[0];
      expect(options).toEqual({ expiresIn: 30 * 60 });
    });

    it("throws when required env vars are missing, without ever calling the SDK", async () => {
      clearEnv();
      const { getDownloadUrl } = await importFreshClient();

      await expect(getDownloadUrl("some/key")).rejects.toThrow(Error);
      expect(mockS3Client).not.toHaveBeenCalled();
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });
  });

  describe("client singleton", () => {
    it("builds the S3Client once (region auto, forcePathStyle) and reuses it across calls", async () => {
      setValidEnv();
      const { getUploadUrl, getDownloadUrl } = await importFreshClient();

      await getUploadUrl("key-a", "application/pdf");
      await getDownloadUrl("key-b");

      expect(mockS3Client).toHaveBeenCalledTimes(1);
      expect(mockS3Client).toHaveBeenCalledWith({
        region: "auto",
        endpoint: VALID_ENV.R2_ENDPOINT,
        forcePathStyle: true,
        credentials: {
          accessKeyId: VALID_ENV.R2_ACCESS_KEY_ID,
          secretAccessKey: VALID_ENV.R2_SECRET_ACCESS_KEY,
        },
      });
    });
  });
});
