import { z } from "zod";

// TODO(Sprint 3 #45-48): fill in real field-level validation for the
// setlists routes in PRD §22, including BR-01/BR-07/BR-09.
export const setlistsSchema = z.object({});
export type SetlistsInput = z.infer<typeof setlistsSchema>;
