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
    };
    Enums: {
      user_role: UserRole;
    };
    CompositeTypes: Record<string, never>;
  };
};
