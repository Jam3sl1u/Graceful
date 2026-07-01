import { z } from "zod";

// TODO(Sprint 3 #52-53): fill in real field-level validation for the
// google-calendar routes in PRD §22.
export const googleCalendarSchema = z.object({});
export type GoogleCalendarInput = z.infer<typeof googleCalendarSchema>;
