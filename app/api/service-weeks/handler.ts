import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { createServiceWeekSchema } from "@/schemas/service-weeks";

type ServiceWeeksRow = Database["public"]["Tables"]["service_weeks"]["Row"];

export type ServiceWeekResponse = {
  id: string;
  serviceDate: string;
  title: string | null;
  sermonTopic: string | null;
  sermonScripture: string | null;
  speakerName: string | null;
  notes: string | null;
  isCancelled: boolean;
  createdBy: string | null;
  createdAt: string;
};

export function toServiceWeekResponse(row: ServiceWeeksRow): ServiceWeekResponse {
  return {
    id: row.id,
    serviceDate: row.service_date,
    title: row.title,
    sermonTopic: row.sermon_topic,
    sermonScripture: row.sermon_scripture,
    speakerName: row.speaker_name,
    notes: row.notes,
    isCancelled: row.is_cancelled,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// GET /api/service-weeks — any authenticated member of the group. Guests are
// restricted to weeks they have an invitation for.
export async function listServiceWeeks(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    if (ctx.role === "guest") {
      const { data: invitations, error: invitationsError } = await supabase
        .from("invitations")
        .select("service_week_id")
        .eq("user_id", ctx.userId);

      if (invitationsError) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }

      const serviceWeekIds = [...new Set((invitations ?? []).map((i) => i.service_week_id))];
      if (serviceWeekIds.length === 0) {
        return ok({ serviceWeeks: [] });
      }

      const { data, error } = await supabase
        .from("service_weeks")
        .select("*")
        .eq("church_group_id", ctx.churchGroupId)
        .in("id", serviceWeekIds)
        .order("service_date", { ascending: false });

      if (error) {
        return fail("Internal error", ErrorCode.INTERNAL, 500);
      }

      return ok({ serviceWeeks: (data ?? []).map(toServiceWeekResponse) });
    }

    const { data, error } = await supabase
      .from("service_weeks")
      .select("*")
      .eq("church_group_id", ctx.churchGroupId)
      .order("service_date", { ascending: false });

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ serviceWeeks: (data ?? []).map(toServiceWeekResponse) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/service-weeks — set_leader/admin only. Auto-creates a draft
// setlist for the new week (PRD Flow 4).
export async function createServiceWeek(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const body = await req.json().catch(() => null);
    const parsedResult = createServiceWeekSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const parsed = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    // The hand-rolled Insert types in lib/supabase/types.ts mark some
    // DB-defaulted columns as required even though they have defaults —
    // cast narrowly here rather than widening the shared type (mirrors
    // app/api/profile/handler.ts updateProfile).
    const weekInsertPayload = {
      church_group_id: ctx.churchGroupId,
      service_date: parsed.serviceDate,
      title: parsed.title,
      sermon_topic: parsed.sermonTopic,
      sermon_scripture: parsed.sermonScripture,
      speaker_name: parsed.speakerName,
      created_by: ctx.userId,
    } as unknown as Database["public"]["Tables"]["service_weeks"]["Insert"];

    const { data: week, error: weekError } = await supabase
      .from("service_weeks")
      .insert(weekInsertPayload)
      .select("*")
      .maybeSingle();

    if (weekError || !week) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    // setlists.service_week_id is unique, so this must run after the week
    // insert succeeds. Two sequential inserts (not a transaction) is
    // accepted here — there is no RPC in scope; an orphaned week on setlist
    // failure is an accepted edge case.
    const setlistInsertPayload = {
      church_group_id: ctx.churchGroupId,
      service_week_id: week.id,
      created_by: ctx.userId,
    } as unknown as Database["public"]["Tables"]["setlists"]["Insert"];

    const { error: setlistError } = await supabase.from("setlists").insert(setlistInsertPayload);

    if (setlistError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ serviceWeek: toServiceWeekResponse(week) }, 201);
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
