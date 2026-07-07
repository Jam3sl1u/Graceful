import { z } from "zod";

// Body for POST /api/instruments and POST /api/instruments/custom.
export const createInstrumentSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export type CreateInstrumentInput = z.infer<typeof createInstrumentSchema>;
