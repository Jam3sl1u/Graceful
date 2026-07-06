// Hand-written minimal types for Cluster 1 users table.
// Regenerate fully (bunx supabase gen types typescript --local) once all
// cluster migrations have landed. Do not add types for tables that don't
// exist yet — keep bun run typecheck passing at every PR.
//
// Shape must satisfy supabase-js v2 GenericSchema / GenericTable interfaces
// so that from().select().eq().maybeSingle() returns typed data.

import type { UserRole } from "@/types/domain";

type UsersRow = {
  id: string;
  clerk_id: string;
  church_group_id: string;
  role: UserRole;
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

type InstrumentsRow = {
  id: string;
  church_group_id: string;
  name: string;
  is_default: boolean;
  created_by: string | null;
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
        Insert: Omit<ChurchGroupsRow, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<ChurchGroupsRow>;
        Relationships: [];
      };
      instruments: {
        Row: InstrumentsRow;
        Insert: Omit<InstrumentsRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<InstrumentsRow>;
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
          p_user_name: string;
          p_user_email: string | null;
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
