import { z } from "zod";

// Returns true iff `tz` is a valid IANA timezone identifier recognized by the
// runtime's Intl implementation. Deliberately does not hardcode a timezone list.
function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const createChurchGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .refine(isValidIanaTimezone, { message: "Invalid IANA timezone" })
    .default("America/Chicago"),
  denomination: z.string().trim().max(100).optional(),
  logoUrl: z.string().trim().max(2048).optional(), // R2 object key, never a public URL
});

export type CreateChurchGroupInput = z.infer<typeof createChurchGroupSchema>;

export const joinChurchGroupSchema = z.object({
  inviteCode: z.string().trim().toUpperCase().min(1).max(20),
});

export type JoinChurchGroupInput = z.infer<typeof joinChurchGroupSchema>;
