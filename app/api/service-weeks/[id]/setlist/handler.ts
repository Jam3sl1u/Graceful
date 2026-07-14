import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";

type SetlistsRow = Database["public"]["Tables"]["setlists"]["Row"];

export type SetlistResponse = {
  id: string;
  serviceWeekId: string;
  status: "draft" | "published";
  publishedAt: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toSetlistResponse(row: SetlistsRow): SetlistResponse {
  return {
    id: row.id,
    serviceWeekId: row.service_week_id,
    status: row.status,
    publishedAt: row.published_at,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/service-weeks/:id/setlist — any authenticated member. Guests must
// have a matching invitation for this week, or the row is treated as not
// found (do NOT leak existence via 403). Members/guests only see it once
// published — RLS filters out drafts for them, so a filtered-out draft and a
// genuinely missing setlist both map to 404 here.
export async function getSetlist(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data, error } = await supabase
      .from("setlists")
      .select("*")
      .eq("service_week_id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!data) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    if (ctx.role === "guest") {
      const { data: invitation, error: invitationError } = await supabase
        .from("invitations")
        .select("id")
        .eq("service_week_id", id)
        .eq("user_id", ctx.userId)
        .maybeSingle();

      if (invitationError) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }
      if (!invitation) {
        return fail("Not found", ErrorCode.NOT_FOUND, 404);
      }
    }

    return ok({ setlist: toSetlistResponse(data) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/service-weeks/:id/setlist — set_leader/admin only. Get-or-create
// safety net: a draft setlist is already auto-created when a service week is
// created (createServiceWeek), so this returns the existing setlist (200) if
// one exists, otherwise creates a fresh draft (201). Keeps the "one setlist
// per week" invariant consistent with the DB unique constraint. No request
// body — zero songs is a valid setlist state (BR-01).
export async function createSetlist(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    // Tenant-scoped week existence check (security-required, not optional):
    // prevents creating a setlist that points at another tenant's / a
    // nonexistent week.
    const { data: week, error: weekError } = await supabase
      .from("service_weeks")
      .select("id")
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (weekError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!week) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    const { data: existing, error: existingError } = await supabase
      .from("setlists")
      .select("*")
      .eq("service_week_id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (existingError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (existing) {
      return ok({ setlist: toSetlistResponse(existing) });
    }

    // The hand-rolled Insert type marks some DB-defaulted columns as
    // required even though they have defaults — cast narrowly here rather
    // than widening the shared type (mirrors createServiceWeek). `status`
    // defaults to 'draft' in the DB — do not set it.
    const insertPayload = {
      church_group_id: ctx.churchGroupId,
      service_week_id: id,
      created_by: ctx.userId,
    } as unknown as Database["public"]["Tables"]["setlists"]["Insert"];

    const { data: created, error: insertError } = await supabase
      .from("setlists")
      .insert(insertPayload)
      .select("*")
      .maybeSingle();

    if (insertError || !created) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ setlist: toSetlistResponse(created) }, 201);
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
