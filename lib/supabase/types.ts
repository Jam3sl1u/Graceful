// Hand-written minimal types for Cluster 1 users table.
// Regenerate fully (bunx supabase gen types typescript --local) once all
// cluster migrations have landed. Do not add types for tables that don't
// exist yet — keep bun run typecheck passing at every PR.
//
// Shape must satisfy supabase-js v2 GenericSchema / GenericTable interfaces
// so that from().select().eq().maybeSingle() returns typed data.

import type { UserRole, VocalCapability } from "@/types/domain";

type UsersRow = {
  id: string;
  clerk_id: string;
  church_group_id: string;
  role: UserRole;
  name: string;
  email: string | null;
  phone: string | null;
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
      audit_logs: {
        Row: AuditLogsRow;
        Insert: Omit<AuditLogsRow, "id" | "created_at"> & { id?: string; created_at?: string };
        Update: Partial<AuditLogsRow>;
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
    };
    Enums: {
      user_role: UserRole;
    };
    CompositeTypes: Record<string, never>;
  };
};
