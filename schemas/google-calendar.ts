import { z } from "zod";

// GET /api/google-calendar/callback query params. Google sends either
// `error` (user denied consent) or `code` + `state`. All three are opaque
// provider-supplied strings — bound their length so a hostile redirect
// can't push an unbounded value into exchangeCode()/the CSRF comparison.
export const googleCalendarCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().min(1).max(200).optional(),
});
export type GoogleCalendarCallbackQuery = z.infer<typeof googleCalendarCallbackQuerySchema>;
