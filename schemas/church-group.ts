import { z } from "zod";

// TODO(Sprint 1 #15-19): fill in real field-level validation per the
// church-group routes in PRD §22.
export const churchGroupSchema = z.object({});
export type ChurchGroupInput = z.infer<typeof churchGroupSchema>;
