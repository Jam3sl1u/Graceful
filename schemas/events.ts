import { z } from "zod";

export const eventTypeSchema = z.enum([
  "pre_practice",
  "rehearsal",
  "sound_check",
  "service",
]);

// POST /api/events body. Shape only. BR-10 time-window/order is enforced in
// the handler (returns 422, not 400) via validateEventTiming below.
export const createEventSchema = z.object({
  serviceWeekId: z.string().uuid(),
  type: eventTypeSchema,
  name: z.string().trim().min(1).max(100),
  location: z.string().trim().min(1).max(200).nullish(),
  startTime: z.string().datetime({ offset: true }),
  endTime: z.string().datetime({ offset: true }),
  // events.notes is a `text` column (no DB-level cap), so this is an
  // app-layer limit. 2000 matches the repo's existing long-free-text
  // convention (schemas/profile.ts bio).
  notes: z.string().trim().min(1).max(2000).nullish(),
});
export type CreateEventInput = z.infer<typeof createEventSchema>;

// PUT /api/events/:id body — same mutable fields, all optional, at least one
// present. serviceWeekId is intentionally NOT updatable (moving an event
// between weeks is out of scope).
export const updateEventSchema = z
  .object({
    type: eventTypeSchema.optional(),
    name: z.string().trim().min(1).max(100).optional(),
    location: z.string().trim().min(1).max(200).nullish(),
    startTime: z.string().datetime({ offset: true }).optional(),
    endTime: z.string().datetime({ offset: true }).optional(),
    // events.notes is a `text` column (no DB-level cap), so this is an
    // app-layer limit. 2000 matches the repo's existing long-free-text
    // convention (schemas/profile.ts bio).
    notes: z.string().trim().min(1).max(2000).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, "at least one field required");
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

// BR-10 (PRD §8): end must be after start; both within 72h of service_date.
// Pure + deterministic so it is unit-testable in isolation. service_date is a
// DATE (YYYY-MM-DD); anchor it at 00:00:00 UTC (see Decisions in spec).
// Returns an error message string on violation, or null when valid.
export const BR10_WINDOW_MS = 72 * 60 * 60 * 1000;

export function validateEventTiming(
  serviceDate: string,
  startTime: string,
  endTime: string,
): string | null {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  if (!(end > start)) return "end_time must be after start_time";
  const anchor = new Date(`${serviceDate}T00:00:00.000Z`).getTime();
  if (Math.abs(start - anchor) > BR10_WINDOW_MS || Math.abs(end - anchor) > BR10_WINDOW_MS) {
    return "event times must be within 72 hours of the service date";
  }
  return null;
}

// POST /api/events/:id/attendees body.
export const assignAttendeeSchema = z.object({
  userId: z.string().uuid(),
});
export type AssignAttendeeInput = z.infer<typeof assignAttendeeSchema>;
