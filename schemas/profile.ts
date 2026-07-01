import { z } from "zod";

// TODO(Sprint 1 #21): fill in real field-level validation per PRD §13.4.
export const profileSchema = z.object({});
export type ProfileInput = z.infer<typeof profileSchema>;
