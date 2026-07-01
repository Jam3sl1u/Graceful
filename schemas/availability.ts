import { z } from "zod";

// TODO(Sprint 2 #25-27): fill in real field-level validation for the
// availability routes in PRD §22.
export const availabilitySchema = z.object({});
export type AvailabilityInput = z.infer<typeof availabilitySchema>;
