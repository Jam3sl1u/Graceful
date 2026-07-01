import { z } from "zod";

// TODO(Sprint 1 #22): fill in real field-level validation for the
// instruments routes in PRD §22.
export const instrumentsSchema = z.object({});
export type InstrumentsInput = z.infer<typeof instrumentsSchema>;
