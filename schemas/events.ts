import { z } from "zod";

// TODO(Sprint 3 #50-51): fill in real field-level validation for the
// events routes in PRD §22, including BR-10.
export const eventsSchema = z.object({});
export type EventsInput = z.infer<typeof eventsSchema>;
