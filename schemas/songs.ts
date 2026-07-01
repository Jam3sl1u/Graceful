import { z } from "zod";

// TODO(Sprint 3 #44,49): fill in real field-level validation for the
// songs routes in PRD §22.
export const songsSchema = z.object({});
export type SongsInput = z.infer<typeof songsSchema>;
