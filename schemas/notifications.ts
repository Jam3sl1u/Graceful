import { z } from "zod";

// TODO(Sprint 4 #60-62): fill in real field-level validation for the
// notifications routes in PRD §22, including BR-14.
export const notificationsSchema = z.object({});
export type NotificationsInput = z.infer<typeof notificationsSchema>;

// PRD §6.9.1 defaults — used when the caller has no notification_preferences
// row yet, and as the merge base for a partial PUT.
export const NOTIFICATION_PREFERENCE_DEFAULTS = {
  invitationSms: true,
  invitationEmail: true,
  invitationInapp: true,
  reminderSms: true,
  reminderEmail: false,
  reminderHoursBefore: 24,
  setlistSms: true,
  setlistEmail: true,
  gcalSyncEnabled: false,
} as const;

export const MIN_REMINDER_HOURS_BEFORE = 1;
export const MAX_REMINDER_HOURS_BEFORE = 168; // 1 week

// PUT /api/notifications/preferences body. Every field is optional: omitted
// fields keep their current stored value (partial merge, see spec Decisions).
// BR-14 is NOT enforced here — it is enforced in the handler against the
// MERGED state, because a partial body alone cannot express the final state.
export const updateNotificationPreferencesSchema = z.object({
  invitationSms: z.boolean().optional(),
  invitationEmail: z.boolean().optional(),
  invitationInapp: z.boolean().optional(),
  reminderSms: z.boolean().optional(),
  reminderEmail: z.boolean().optional(),
  reminderHoursBefore: z
    .number()
    .int()
    .min(MIN_REMINDER_HOURS_BEFORE)
    .max(MAX_REMINDER_HOURS_BEFORE)
    .optional(),
  setlistSms: z.boolean().optional(),
  setlistEmail: z.boolean().optional(),
  gcalSyncEnabled: z.boolean().optional(),
});

export type UpdateNotificationPreferencesInput = z.infer<
  typeof updateNotificationPreferencesSchema
>;
