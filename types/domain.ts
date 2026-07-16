// Enums from PRD §20.2 (Data Model / Schema). Kept as string-literal unions so
// they line up 1:1 with the Postgres enum types created in Sprint 0 #7-12.

export type UserRole = "admin" | "set_leader" | "member" | "guest";

export type InvitationStatus = "pending" | "accepted" | "denied" | "withdrawn" | "expired";

export type EventType = "pre_practice" | "rehearsal" | "sound_check" | "service";

export type ResolutionType = "replaced" | "withdrawn" | "member_reconfirmed" | "admin_dismissed";

export type SetlistStatus = "draft" | "published";

export type VocalCapability = "lead" | "harmony" | "both" | "none";

export type ChatPref = "sms" | "email" | "in_app";

export type JobStatus = "queued" | "processing" | "succeeded" | "failed";

export type AudioSource = "upload" | "spotify";

export type NotificationType =
  | "set_invitation"
  | "invitation_reminder"
  | "invitation_accepted"
  | "invitation_denied"
  | "invitation_withdrawn"
  | "practice_reminder"
  | "setlist_released"
  | "scheduling_conflict"
  | "chat_mention"
  | "devotion_shared"
  | "new_church_document"
  | "google_calendar_event"
  | "service_week_cancelled"
  | "service_week_reactivated"
  | "google_calendar_reauth_required";
