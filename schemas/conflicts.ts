import { z } from "zod";

// TODO(Sprint 2 #37-38): fill in real field-level validation for the
// conflicts routes in PRD §22.
export const conflictsSchema = z.object({});
export type ConflictsInput = z.infer<typeof conflictsSchema>;
