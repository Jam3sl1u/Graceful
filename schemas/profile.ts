import { z } from "zod";

export const VOCAL_CAPABILITY_VALUES = ["lead", "harmony", "both", "none"] as const;

// PUT /api/profile body. Full replace of the two editable profile fields.
// bio: optional/nullable free text; empty/whitespace-only is normalized to null.
export const updateProfileSchema = z.object({
  vocalCapability: z.enum(VOCAL_CAPABILITY_VALUES),
  bio: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
