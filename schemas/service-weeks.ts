import { z } from "zod";

// POST /api/service-weeks body. Per the issue AC, all five fields are
// required (the DB columns are nullable, and PRD Flow 4 §21.4 calls
// sermon topic/scripture "optional", but the issue AC is authoritative here).
export const createServiceWeekSchema = z.object({
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  title: z.string().trim().min(1).max(100),
  // service_weeks.sermon_topic is a `text` column (no DB-level cap), so this
  // is an app-layer limit. 200 matches the repo's "short titled text"
  // convention (songs.title, song_documents.name).
  sermonTopic: z.string().trim().min(1).max(200),
  // service_weeks.sermon_scripture is a `text` column (no DB-level cap), so
  // this is an app-layer limit. 200 matches the repo's "short titled text"
  // convention (songs.title, song_documents.name).
  sermonScripture: z.string().trim().min(1).max(200),
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
    // service_weeks.sermon_topic is a `text` column (no DB-level cap), so
    // this is an app-layer limit. 200 matches the repo's "short titled text"
    // convention (songs.title, song_documents.name).
    sermonTopic: z.string().trim().min(1).max(200).optional(),
    // service_weeks.sermon_scripture is a `text` column (no DB-level cap), so
    // this is an app-layer limit. 200 matches the repo's "short titled text"
    // convention (songs.title, song_documents.name).
    sermonScripture: z.string().trim().min(1).max(200).optional(),
    speakerName: z.string().trim().min(1).max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "at least one field required");

export type UpdateServiceWeekInput = z.infer<typeof updateServiceWeekSchema>;
