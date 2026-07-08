import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { updateServiceWeekSchema } from "@/schemas/service-weeks";
import { toServiceWeekResponse } from "../handler";

// GET /api/service-weeks/:id — any authenticated member. Guests must have a
// matching invitation for this week, or the row is treated as not found (do
// NOT leak existence via 403).
export async function getServiceWeek(
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
      .from("service_weeks")
      .select("*")
      .eq("id", id)
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

    return ok({ serviceWeek: toServiceWeekResponse(data) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// PUT /api/service-weeks/:id — set_leader/admin only.
export async function updateServiceWeek(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const body = await req.json().catch(() => null);
    const parsedResult = updateServiceWeekSchema.safeParse(body);
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

    const patch: Database["public"]["Tables"]["service_weeks"]["Update"] = {};
    if (parsed.serviceDate !== undefined) patch.service_date = parsed.serviceDate;
    if (parsed.title !== undefined) patch.title = parsed.title;
    if (parsed.sermonTopic !== undefined) patch.sermon_topic = parsed.sermonTopic;
    if (parsed.sermonScripture !== undefined) patch.sermon_scripture = parsed.sermonScripture;
    if (parsed.speakerName !== undefined) patch.speaker_name = parsed.speakerName;

    const { data, error } = await supabase
      .from("service_weeks")
      .update(patch)
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .select("*")
      .maybeSingle();

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!data) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    return ok({ serviceWeek: toServiceWeekResponse(data) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
