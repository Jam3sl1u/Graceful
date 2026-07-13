import { z } from "zod";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // YYYY-MM-DD

// Validates that a string is a real calendar date in YYYY-MM-DD form by
// round-tripping through Date: constructing it (UTC, to avoid local-timezone
// off-by-one) and confirming it re-serializes to the same string. This
// rejects strings like "2026-02-30" that pass the regex but aren't real dates.
function isValidDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

// GET /api/availability query params
export const getAvailabilityQuerySchema = z.object({
  user_id: z.string().uuid().optional(),
});
export type GetAvailabilityQuery = z.infer<typeof getAvailabilityQuerySchema>;

// DELETE /api/availability/:date route param.
export const availabilityDateParamSchema = z
  .string()
  .refine(isValidDateString, { message: "date param must be a valid YYYY-MM-DD calendar date" });

// One PUT entry: EITHER a single `date` OR an inclusive `startDate`..`endDate`
// range. isAvailable defaults true (applied in the handler, not here).
// note: trimmed; empty -> null (mirrors the bio normalization in schemas/profile.ts).
export const setAvailabilityEntrySchema = z
  .object({
    date: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    isAvailable: z.boolean().optional(),
    note: z
      .string()
      .trim()
      .max(500)
      .nullish()
      .transform((v) => (v && v.length > 0 ? v : null)),
  })
  .superRefine((entry, ctx) => {
    const hasDate = entry.date !== undefined;
    const hasStart = entry.startDate !== undefined;
    const hasEnd = entry.endDate !== undefined;

    // Exactly one form must be present: `date` alone, OR both `startDate`
    // and `endDate` together.
    if (hasDate && (hasStart || hasEnd)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either `date` or `startDate`/`endDate`, not both",
        path: ["date"],
      });
      return;
    }

    if (!hasDate && !(hasStart && hasEnd)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either `date` or both `startDate` and `endDate`",
        path: ["date"],
      });
      return;
    }

    if (hasDate) {
      if (!isValidDateString(entry.date as string)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "`date` must be a valid YYYY-MM-DD calendar date",
          path: ["date"],
        });
      }
      return;
    }

    const startDate = entry.startDate as string;
    const endDate = entry.endDate as string;
    const startValid = isValidDateString(startDate);
    const endValid = isValidDateString(endDate);

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
    if (startValid && endValid && startDate > endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`startDate` must be less than or equal to `endDate`",
        path: ["startDate"],
      });
    }
  });
export type SetAvailabilityEntry = z.infer<typeof setAvailabilityEntrySchema>;

// PUT /api/availability body
export const setAvailabilitySchema = z.object({
  entries: z.array(setAvailabilityEntrySchema).min(1).max(400),
});
export type SetAvailabilityInput = z.infer<typeof setAvailabilitySchema>;
