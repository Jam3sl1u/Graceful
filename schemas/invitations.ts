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
// responseToken is optional (#49): absent/empty for the in-app path;
// present for the no-session SMS/email path, same 64-char hex shape as
// acceptInvitationSchema's responseToken.
export const denyInvitationSchema = z.object({
  reason: z.string().trim().max(200).optional(),
  responseToken: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type DenyInvitationInput = z.infer<typeof denyInvitationSchema>;

export const acceptInvitationParamSchema = z.string().uuid();

// Route param for /api/invitations/:id/* (deny, withdraw). Same shape as
// acceptInvitationParamSchema.
export const invitationIdParamSchema = z.string().uuid();

// Body is optional: absent/empty for the in-app path; { responseToken } for the
// no-session SMS/email path. Token is the 64-char hex response_token.
export const acceptInvitationSchema = z.object({
  responseToken: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

// GET /api/invitations/respond/:token param (#44). Same 64-char hex shape as the
// response_token. On mismatch the route returns 404 (NOT 400) — see handler note.
export const respondTokenParamSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);

// GET /api/invitations?serviceWeekId= query (#48 Week View roster).
export const listInvitationsQuerySchema = z.object({
  serviceWeekId: z.string().uuid(),
});
export type ListInvitationsQuery = z.infer<typeof listInvitationsQuerySchema>;

// POST /api/invitations/guest body (#72). email is normalized to lowercase
// here so the handler's existing-user lookup and the RPC insert agree.
export const createGuestInvitationSchema = z.object({
  serviceWeekId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email().max(255),
  name: z.string().trim().min(1).max(100).optional(),
  roleNote: z.string().trim().min(1).max(500).optional(),
  acknowledgeConflict: z.boolean().optional(),
});
export type CreateGuestInvitationInput = z.infer<typeof createGuestInvitationSchema>;

// POST /api/invitations/guest/claim body (#72). Same 64-char hex response_token
// shape as acceptInvitationSchema.
export const claimGuestInvitationSchema = z.object({
  responseToken: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/),
});
export type ClaimGuestInvitationInput = z.infer<typeof claimGuestInvitationSchema>;
