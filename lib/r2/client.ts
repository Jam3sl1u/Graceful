import "server-only";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const SIGNED_URL_EXPIRY_SECONDS = 30 * 60; // 30 min (issue AC + #15 baseline)

// lazy singleton
let client: S3Client | null = null;

function getClient(): S3Client {
  if (client) return client;

  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucketName) {
    throw new Error("R2 is not configured — missing required environment variable(s)");
  }

  client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

export async function getUploadUrl(key: string, contentType?: string): Promise<string> {
  return getSignedUrl(
    getClient(),
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: SIGNED_URL_EXPIRY_SECONDS },
  );
}

export async function getDownloadUrl(key: string): Promise<string> {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }),
    { expiresIn: SIGNED_URL_EXPIRY_SECONDS },
  );
}
