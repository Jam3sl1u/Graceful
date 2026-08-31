import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { dispatchNotification, appNotificationUrl } from "@/lib/notifications/dispatch";
import { schedulingConflictSms } from "@/lib/notifications/sms-templates";
import { formatWeekLabel } from "@/lib/scheduling/reminder";

// BR-15 (PRD §8): a member losing an accepted invitation's availability —
// whether by explicitly marking unavailable or by quietly deleting the
// declaration — must trigger conflict detection the same way. Callers pass
// a reason so each trigger path stays distinguishable in conflicts.trigger_reason.
export type ConflictTriggerReason = "availability_deleted" | "marked_unavailable";

// Records a conflict for the caller's OWN user + church group (both derived
// server-side from the JWT inside the record_availability_conflict RPC) for
// every accepted invitation to a service on `date`. Returns true iff at
// least one conflict was recorded. `supabase` MUST be the RLS-scoped client
// for the acting user (getSupabaseClient(jwt)) — the RPC runs SECURITY
// DEFINER specifically because conflicts has no member-level INSERT policy.
// Throws ApiException(INTERNAL, 500) on DB error; never swallows.
export async function recordAvailabilityConflict(
  supabase: SupabaseClient<Database>,
  date: string,
  reason: ConflictTriggerReason,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("record_availability_conflict", {
    p_date: date,
    p_trigger_reason: reason,
  });

  if (error) {
    throw new ApiException("Internal error", ErrorCode.INTERNAL, 500);
  }

  return Boolean(data);
}

// Scheduling conflict — SMS + Email to admins (PRD §14: "Scheduling conflict |
// Admin only | SMS + Email"). Best-effort, NEVER throws — unlike
// recordAvailabilityConflict, which throws on DB error and must stay that way.
// Call this only after recordAvailabilityConflict has reported a conflict for
// `date`. The trigger path runs as an authenticated member and
// users_select_tenant lets them read the admins' contact rows directly, so no
// RPC is needed here.
export async function dispatchConflictNotifications(
  supabase: SupabaseClient<Database>,
  actor: { userId: string; churchGroupId: string },
  date: string, // YYYY-MM-DD, the availability date
): Promise<void> {
  try {
    await dispatchConflictNotificationsInner(supabase, actor, date);
  } catch (err) {
    console.error("dispatchConflictNotifications: failed", actor.userId, err);
  }
}

async function dispatchConflictNotificationsInner(
  supabase: SupabaseClient<Database>,
  actor: { userId: string; churchGroupId: string },
  date: string,
): Promise<void> {
  const { data: memberRow, error: memberError } = await supabase
    .from("users")
    .select("name")
    .eq("id", actor.userId)
    .maybeSingle();
  if (memberError) return;

  const { data: recipientRows, error: recipientsError } = await supabase
    .from("users")
    .select("id, name, email, phone, sms_opted_in")
    .eq("church_group_id", actor.churchGroupId)
    .in("role", ["admin", "set_leader"])
    .neq("id", actor.userId);
  if (recipientsError) return;
  if ((recipientRows ?? []).length === 0) return;

  const memberName = memberRow?.name ?? "";
  const label = formatWeekLabel(null, date);
  const link = appNotificationUrl("/conflicts");

  await dispatchNotification({
    recipients: (recipientRows ?? []).map((r) => ({
      userId: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      smsOptedIn: r.sms_opted_in,
    })),
    sms: { body: schedulingConflictSms({ memberName, date: label, link }) },
    email: { template: "scheduling_conflict", data: { memberName, date: label, link } },
  });
}
