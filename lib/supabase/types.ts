// Hand-written minimal types for Cluster 1 users table.
// Regenerate fully (bunx supabase gen types typescript --local) once all
// cluster migrations have landed. Do not add types for tables that don't
// exist yet — keep bun run typecheck passing at every PR.
//
// Shape must satisfy supabase-js v2 GenericSchema / GenericTable interfaces
// so that from().select().eq().maybeSingle() returns typed data.

import type {
  EventType,
  InvitationStatus,
  NotificationType,
  ResolutionType,
  SetlistStatus,
  UserRole,
  VocalCapability,
} from "@/types/domain";

type UsersRow = {
  id: string;
  clerk_id: string;
  church_group_id: string;
  role: UserRole;
  name: string;
  email: string | null;
  phone: string | null;
  sms_opted_in: boolean;
  anonymized_at: string | null;
};

type ChurchGroupsRow = {
  id: string;
  name: string;
  denomination: string | null;
  timezone: string;
  logo_url: string | null;
  invite_code: string;
  created_at: string;
  updated_at: string;
};

type MemberProfilesRow = {
  id: string;
  user_id: string;
  vocal_capability: VocalCapability;
  bio: string | null;
  created_at: string;
};

type InstrumentsRow = {
  id: string;
  church_group_id: string;
  name: string;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
};

type MemberInstrumentsRow = {
  id: string;
  member_profile_id: string;
  instrument_id: string;
};

type SongsRow = {
  id: string;
  church_group_id: string;
  title: string;
  artist: string | null;
  default_key: string | null;
  bpm: number | null;
  tags: string[] | null;
  spotify_id: string | null;
  created_by: string | null;
  created_at: string;
};

type SongDocumentsRow = {
  id: string;
  song_id: string;
  church_group_id: string;
  name: string;
  file_key: string;
  file_type: string;
  file_size_bytes: number;
  uploaded_by: string | null;
  created_at: string;
};

type AuditLogsRow = {
  id: string;
  church_group_id: string;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

type ServiceWeeksRow = {
  id: string;
  church_group_id: string;
  service_date: string;
  title: string | null;
  sermon_topic: string | null;
  sermon_scripture: string | null;
  speaker_name: string | null;
  notes: string | null;
  is_cancelled: boolean;
  created_by: string | null;
  created_at: string;
};

type SetlistsRow = {
  id: string;
  church_group_id: string;
  service_week_id: string;
  status: SetlistStatus;
  published_at: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type InvitationsRow = {
  id: string;
  church_group_id: string;
  service_week_id: string;
  user_id: string;
  role_note: string | null;
  status: InvitationStatus;
  response_token: string;
  responded_at: string | null;
  denial_reason: string | null;
  denial_count: number;
  response_deadline: string | null;
  invited_by: string | null;
  created_at: string;
  last_reminded_at: string | null;
};

type AvailabilityRow = {
  id: string;
  user_id: string;
  church_group_id: string;
  date: string; // YYYY-MM-DD
  is_available: boolean;
  note: string | null;
  created_at: string;
};

type ConflictsRow = {
  id: string;
  church_group_id: string;
  invitation_id: string;
  triggered_by: string | null;
  trigger_reason: string | null;
  replacement_suggestion_user_id: string | null;
  resolved_at: string | null;
  resolution_type: ResolutionType | null;
  created_at: string;
};

// Added for #47 (conflict resolution withdraw path needs to find + clear a
// member's event_attendees rows for a service week's events).
type EventsRow = {
  id: string;
  church_group_id: string;
  service_week_id: string;
  type: EventType;
  name: string;
  location: string | null;
  start_time: string;
  end_time: string;
  google_calendar_event_id: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};

type EventAttendeesRow = {
  id: string;
  event_id: string;
  user_id: string;
  created_at: string;
};

type NotificationsRow = {
  id: string;
  church_group_id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link_entity_type: string | null;
  link_entity_id: string | null;
  is_read: boolean;
  created_at: string;
};

export type Database = {
  public: {
    Tables: {
      users: {
        Row: UsersRow;
        Insert: Omit<UsersRow, "id"> & { id?: string };
        Update: Partial<UsersRow>;
        Relationships: [];
      };
      church_groups: {
        Row: ChurchGroupsRow;
        Insert: Omit<ChurchGroupsRow, "id"> & { id?: string };
        Update: Partial<ChurchGroupsRow>;
        Relationships: [];
      };
      member_profiles: {
        Row: MemberProfilesRow;
        Insert: Omit<MemberProfilesRow, "id"> & { id?: string };
        Update: Partial<MemberProfilesRow>;
        Relationships: [];
      };
      instruments: {
        Row: InstrumentsRow;
        Insert: Omit<InstrumentsRow, "id"> & { id?: string };
        Update: Partial<InstrumentsRow>;
        Relationships: [];
      };
      member_instruments: {
        Row: MemberInstrumentsRow;
        Insert: Omit<MemberInstrumentsRow, "id"> & { id?: string };
        Update: Partial<MemberInstrumentsRow>;
        Relationships: [];
      };
      songs: {
        Row: SongsRow;
        Insert: Omit<
          SongsRow,
          "id" | "created_at" | "artist" | "default_key" | "bpm" | "tags" | "spotify_id" | "created_by"
        > & {
          id?: string;
          created_at?: string;
          artist?: string | null;
          default_key?: string | null;
          bpm?: number | null;
          tags?: string[] | null;
          spotify_id?: string | null;
          created_by?: string | null;
        };
        Update: Partial<SongsRow>;
        Relationships: [];
      };
      song_documents: {
        Row: SongDocumentsRow;
        Insert: Omit<SongDocumentsRow, "id" | "created_at" | "uploaded_by"> & {
          id?: string;
          created_at?: string;
          uploaded_by?: string | null;
        };
        Update: Partial<SongDocumentsRow>;
        Relationships: [];
      };
      audit_logs: {
        Row: AuditLogsRow;
        Insert: Omit<AuditLogsRow, "id" | "created_at"> & { id?: string; created_at?: string };
        Update: Partial<AuditLogsRow>;
        Relationships: [];
      };
      service_weeks: {
        Row: ServiceWeeksRow;
        Insert: Omit<ServiceWeeksRow, "id" | "created_at" | "is_cancelled"> & {
          id?: string;
          created_at?: string;
          is_cancelled?: boolean;
        };
        Update: Partial<ServiceWeeksRow>;
        Relationships: [];
      };
      setlists: {
        Row: SetlistsRow;
        Insert: Omit<
          SetlistsRow,
          "id" | "created_at" | "updated_at" | "status" | "published_at" | "notes"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          status?: SetlistStatus;
          published_at?: string | null;
          notes?: string | null;
        };
        Update: Partial<SetlistsRow>;
        Relationships: [];
      };
      invitations: {
        Row: InvitationsRow;
        Insert: Omit<
          InvitationsRow,
          | "id"
          | "created_at"
          | "status"
          | "responded_at"
          | "denial_reason"
          | "denial_count"
          | "response_deadline"
          | "last_reminded_at"
        > & {
          id?: string;
          created_at?: string;
          status?: InvitationStatus;
          responded_at?: string | null;
          denial_reason?: string | null;
          denial_count?: number;
          response_deadline?: string | null;
          last_reminded_at?: string | null;
        };
        Update: Partial<InvitationsRow>;
        Relationships: [];
      };
      availability: {
        Row: AvailabilityRow;
        Insert: Omit<AvailabilityRow, "id" | "created_at" | "is_available"> & {
          id?: string;
          created_at?: string;
          is_available?: boolean;
        };
        Update: Partial<AvailabilityRow>;
        Relationships: [];
      };
      conflicts: {
        Row: ConflictsRow;
        Insert: Omit<
          ConflictsRow,
          | "id"
          | "created_at"
          | "triggered_by"
          | "trigger_reason"
          | "replacement_suggestion_user_id"
          | "resolved_at"
          | "resolution_type"
        > & {
          id?: string;
          created_at?: string;
          triggered_by?: string | null;
          trigger_reason?: string | null;
          replacement_suggestion_user_id?: string | null;
          resolved_at?: string | null;
          resolution_type?: ResolutionType | null;
        };
        Update: Partial<ConflictsRow>;
        Relationships: [];
      };
      events: {
        Row: EventsRow;
        Insert: Omit<
          EventsRow,
          "id" | "created_at" | "location" | "google_calendar_event_id" | "notes" | "created_by"
        > & {
          id?: string;
          created_at?: string;
          location?: string | null;
          google_calendar_event_id?: string | null;
          notes?: string | null;
          created_by?: string | null;
        };
        Update: Partial<EventsRow>;
        Relationships: [];
      };
      event_attendees: {
        Row: EventAttendeesRow;
        Insert: Omit<EventAttendeesRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<EventAttendeesRow>;
        Relationships: [];
      };
      notifications: {
        Row: NotificationsRow;
        Insert: Omit<NotificationsRow, "id" | "created_at" | "is_read"> & {
          id?: string;
          created_at?: string;
          is_read?: boolean;
        };
        Update: Partial<NotificationsRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_church_group: {
        Args: {
          p_name: string;
          p_timezone: string;
          p_denomination: string | null;
          p_logo_url: string | null;
          p_creator_name: string;
          p_creator_email: string | null;
        };
        Returns: ChurchGroupsRow;
      };
      join_church_group: {
        Args: {
          p_invite_code: string;
          p_member_name: string;
          p_member_email: string | null;
        };
        Returns: UsersRow;
      };
      write_audit_log: {
        Args: {
          p_action: string;
          p_entity_type: string;
          p_entity_id: string;
          p_metadata: Record<string, unknown>;
        };
        Returns: AuditLogsRow;
      };
      remove_church_group_member: {
        Args: {
          p_target_user_id: string;
        };
        Returns: UsersRow;
      };
      record_availability_conflict: {
        Args: {
          p_date: string;
          p_trigger_reason: string;
        };
        Returns: boolean;
      };
      accept_invitation: {
        Args: {
          p_invitation_id: string;
          p_response_token: string | null;
        };
        Returns: {
          status: InvitationStatus;
          already_responded: boolean;
          attendees_added: number;
        };
      };
      deny_invitation: {
        Args: {
          p_invitation_id: string;
          p_response_token: string | null;
          p_reason: string | null;
        };
        Returns: {
          status: InvitationStatus;
          already_responded: boolean;
        };
      };
      get_invitation_by_token: {
        Args: { p_response_token: string };
        Returns: {
          invitation_id: string;
          status: InvitationStatus;
          role_note: string | null;
          response_deadline: string | null;
          service_week: { id: string; service_date: string; title: string | null };
          events: Array<{
            id: string;
            type: EventType;
            name: string;
            location: string | null;
            start_time: string;
            end_time: string;
          }>;
        };
      };
      send_invitation_reminders: {
        Args: Record<string, never>;
        Returns: Array<{
          invitation_id: string;
          user_id: string;
          member_name: string;
          phone: string | null;
          sms_opted_in: boolean;
          service_week_id: string;
          service_date: string;
          week_title: string | null;
        }>;
      };
    };
    Enums: {
      user_role: UserRole;
    };
    CompositeTypes: Record<string, never>;
  };
};
