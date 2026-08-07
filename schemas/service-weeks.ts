import { z } from "zod";
import { isValidDateString } from "@/schemas/availability";

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

export const serviceWeekStatusFilters = ["all", "active", "cancelled"] as const;
export type ServiceWeekStatusFilter = (typeof serviceWeekStatusFilters)[number];

// GET /api/service-weeks/overview query params (#74). All optional; date
// bounds are inclusive and validated as real calendar dates (reuses
// isValidDateString from schemas/availability.ts). No max-range cap (unlike
// MAX_TEAM_RANGE_DAYS) — this endpoint returns weeks, not per-day rows.
export const serviceWeeksOverviewQuerySchema = z
  .object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    status: z.enum(serviceWeekStatusFilters).default("all"),
  })
  .superRefine((query, ctx) => {
    const startValid = query.startDate === undefined || isValidDateString(query.startDate);
    const endValid = query.endDate === undefined || isValidDateString(query.endDate);

    if (!startValid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`startDate` must be a valid YYYY-MM-DD calendar date",
        path: ["startDate"],
      });
    }
    if (!endValid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`endDate` must be a valid YYYY-MM-DD calendar date",
        path: ["endDate"],
      });
    }
    if (!startValid || !endValid) return;

    if (query.startDate && query.endDate && query.startDate > query.endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`startDate` must be less than or equal to `endDate`",
        path: ["startDate"],
      });
    }
  });
export type ServiceWeeksOverviewQuery = z.infer<typeof serviceWeeksOverviewQuerySchema>;
