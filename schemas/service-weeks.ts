import { z } from "zod";

// TODO(Sprint 2 #28-30): fill in real field-level validation for the
// service-weeks routes in PRD §22.
export const serviceWeeksSchema = z.object({});
export type ServiceWeeksInput = z.infer<typeof serviceWeeksSchema>;
