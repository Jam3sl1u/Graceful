import { z } from "zod";

// Body for POST /api/songs/:id/documents/upload-url
export const uploadUrlSchema = z.object({
  name: z.string().trim().min(1).max(200),
  file_type: z.string().trim().min(1).max(50),
  file_size_bytes: z.number().int().positive().max(2147483647), // int4 column bound
});
export type UploadUrlInput = z.infer<typeof uploadUrlSchema>;

// Body for POST /api/songs/:id/documents (register completed upload)
export const registerDocumentSchema = uploadUrlSchema.extend({
  file_key: z.string().trim().min(1).max(1024),
});
export type RegisterDocumentInput = z.infer<typeof registerDocumentSchema>;
