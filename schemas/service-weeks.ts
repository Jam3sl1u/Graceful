import { z } from "zod";

// POST /api/service-weeks body. Per the issue AC, all five fields are
// required (the DB columns are nullable, and PRD Flow 4 §21.4 calls
// sermon topic/scripture "optional", but the issue AC is authoritative here).
export const createServiceWeekSchema = z.object({
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  title: z.string().trim().min(1).max(100),
  sermonTopic: z.string().trim().min(1),
  sermonScripture: z.string().trim().min(1),
  speakerName: z.string().trim().min(1).max(100),
});

export type CreateServiceWeekInput = z.infer<typeof createServiceWeekSchema>;

// PUT /api/service-weeks/:id body. Same fields, all optional; at least one
// must be present.
export const updateServiceWeekSchema = z
  .object({
    serviceDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
      .optional(),
    title: z.string().trim().min(1).max(100).optional(),
    sermonTopic: z.string().trim().min(1).optional(),
    sermonScripture: z.string().trim().min(1).optional(),
    speakerName: z.string().trim().min(1).max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "at least one field required");

export type UpdateServiceWeekInput = z.infer<typeof updateServiceWeekSchema>;
