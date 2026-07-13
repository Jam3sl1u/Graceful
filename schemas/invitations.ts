import { z } from "zod";

// TODO(Sprint 2 #31-38): fill in real field-level validation for the
// invitations routes in PRD §22, including BR-05/BR-08.
export const invitationsSchema = z.object({});
export type InvitationsInput = z.infer<typeof invitationsSchema>;

// POST /api/invitations body (#40). roleNote is optional (DB column is
// nullable). acknowledgeConflict is the BR-05 "warn, then allow override"
// flag: absent/false means a detected double-booking short-circuits with
// 409 CONFLICT; true means proceed despite the warning.
export const createInvitationSchema = z.object({
  serviceWeekId: z.string().uuid(),
  userId: z.string().uuid(),
  roleNote: z.string().trim().min(1).max(500).optional(),
  acknowledgeConflict: z.boolean().optional(),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

// POST /api/invitations/:id/deny body (#42). reason is optional (max 200 chars,
// PRD §6.3 / BR-08). An absent body or empty/whitespace-only reason both mean
// "no reason" and are valid (NOT a 400) — the handler coerces them to null.
export const denyInvitationSchema = z.object({
  reason: z.string().trim().max(200).optional(),
});
export type DenyInvitationInput = z.infer<typeof denyInvitationSchema>;
