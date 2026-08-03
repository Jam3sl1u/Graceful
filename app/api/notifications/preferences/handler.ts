import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import {
  NOTIFICATION_PREFERENCE_DEFAULTS,
  updateNotificationPreferencesSchema,
} from "@/schemas/notifications";

export type NotificationPreferencesResponse = {
  userId: string;
  invitationSms: boolean;
  invitationEmail: boolean;
  invitationInapp: boolean;
  reminderSms: boolean;
  reminderEmail: boolean;
  reminderHoursBefore: number;
  setlistSms: boolean;
  setlistEmail: boolean;
  gcalSyncEnabled: boolean;
};

// Never select or write chat_preference — see spec Decisions / types.ts comment.
const COLUMNS =
  "invitation_sms, invitation_email, invitation_inapp, reminder_sms, reminder_email, reminder_hours_before, setlist_sms, setlist_email, gcal_sync_enabled";

type NotificationPreferencesQueryRow = {
  invitation_sms: boolean;
  invitation_email: boolean;
  invitation_inapp: boolean;
  reminder_sms: boolean;
  reminder_email: boolean;
  reminder_hours_before: number;
  setlist_sms: boolean;
  setlist_email: boolean;
  gcal_sync_enabled: boolean;
};

function mapRow(
  row: NotificationPreferencesQueryRow,
): Omit<NotificationPreferencesResponse, "userId"> {
  return {
    invitationSms: row.invitation_sms,
    invitationEmail: row.invitation_email,
    invitationInapp: row.invitation_inapp,
    reminderSms: row.reminder_sms,
    reminderEmail: row.reminder_email,
    reminderHoursBefore: row.reminder_hours_before,
    setlistSms: row.setlist_sms,
    setlistEmail: row.setlist_email,
    gcalSyncEnabled: row.gcal_sync_enabled,
  };
}

// GET /api/notifications/preferences — the caller's own notification channel
// settings. Ownership is enforced by RLS (user_id = auth_user_id()) and by
// scoping the query to ctx.userId; there is no role gate (PRD auth = Any).
export async function getNotificationPreferences(
  req: NextRequest,
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
      .from("notification_preferences")
      .select(COLUMNS)
      .eq("user_id", ctx.userId)
      .maybeSingle();

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    if (!data) {
      return ok({
        preferences: {
          userId: ctx.userId,
          ...NOTIFICATION_PREFERENCE_DEFAULTS,
        },
      });
    }

    return ok({
      preferences: {
        userId: ctx.userId,
        ...mapRow(data),
      },
    });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// PUT /api/notifications/preferences — partial merge update (see spec
// Decisions): omitted fields keep their current stored value. BR-14 is
// enforced against the merged (not just the submitted) state.
export async function updateNotificationPreferences(
  req: NextRequest,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const body = await req.json().catch(() => null);
    const parsedResult = updateNotificationPreferencesSchema.safeParse(body);
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

    const { data: currentData, error: selectError } = await supabase
      .from("notification_preferences")
      .select(COLUMNS)
      .eq("user_id", ctx.userId)
      .maybeSingle();

    if (selectError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const current = currentData
      ? mapRow(currentData)
      : { ...NOTIFICATION_PREFERENCE_DEFAULTS };

    const merged = { ...current, ...parsed };

    // BR-14: reject any save whose resulting state disables all three
    // invitation channels. Checked against the merged state, not just the
    // submitted body, so a body that only sets one field can still trip this
    // if it disables the last remaining enabled channel.
    if (!merged.invitationSms && !merged.invitationEmail && !merged.invitationInapp) {
      return fail(
        "At least one invitation channel (SMS, email, or in-app) must stay enabled",
        ErrorCode.VALIDATION_FAILED,
        422,
      );
    }

    // chat_preference is deliberately omitted from this payload — see
    // lib/supabase/types.ts comment on NotificationPreferencesRow.
    const upsertPayload = {
      user_id: ctx.userId,
      invitation_sms: merged.invitationSms,
      invitation_email: merged.invitationEmail,
      invitation_inapp: merged.invitationInapp,
      reminder_sms: merged.reminderSms,
      reminder_email: merged.reminderEmail,
      reminder_hours_before: merged.reminderHoursBefore,
      setlist_sms: merged.setlistSms,
      setlist_email: merged.setlistEmail,
      gcal_sync_enabled: merged.gcalSyncEnabled,
    } as unknown as Database["public"]["Tables"]["notification_preferences"]["Insert"];

    const { data, error } = await supabase
      .from("notification_preferences")
      .upsert(upsertPayload, { onConflict: "user_id" })
      .select(COLUMNS)
      .maybeSingle();

    if (error || !data) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({
      preferences: {
        userId: ctx.userId,
        ...mapRow(data),
      },
    });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
