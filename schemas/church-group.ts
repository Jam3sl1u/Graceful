import { z } from "zod";

// TODO(Sprint 1 #15-19): fill in real field-level validation per the
// church-group routes in PRD §22.
export const churchGroupSchema = z.object({});
export type ChurchGroupInput = z.infer<typeof churchGroupSchema>;

const supportedTimeZones = new Set(Intl.supportedValuesOf("timeZone"));

export const createChurchGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .default("America/Chicago")
    .refine((tz) => supportedTimeZones.has(tz), { message: "Invalid IANA timezone" }),
  denomination: z.string().trim().min(1).max(100).optional(),
  logo_url: z.string().trim().url().optional(),
});
export type CreateChurchGroupInput = z.infer<typeof createChurchGroupSchema>;
