import { z } from "zod";

// TODO(Sprint 4 #60-62): fill in real field-level validation for the
// notifications routes in PRD §22, including BR-14.
export const notificationsSchema = z.object({});
export type NotificationsInput = z.infer<typeof notificationsSchema>;
