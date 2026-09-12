import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, type AuthContext, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import {
  listNotificationsQuerySchema,
  notificationIdParamSchema,
} from "@/schemas/notifications";
import { getGuestInboxLinkEntityIds } from "@/lib/notifications/guest-inbox-scope";
import type { NotificationType } from "@/types/domain";

const COLUMNS =
  "id, type, title, body, link_entity_type, link_entity_id, is_read, created_at";

export type NotificationItem = {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  linkEntityType: string | null;
  linkEntityId: string | null;
  isRead: boolean;
  createdAt: string; // ISO timestamp
};

type NotificationQueryRow = {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link_entity_type: string | null;
  link_entity_id: string | null;
  is_read: boolean;
  created_at: string;
};

function mapRow(row: NotificationQueryRow): NotificationItem {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    linkEntityType: row.link_entity_type,
    linkEntityId: row.link_entity_id,
    isRead: row.is_read,
    createdAt: row.created_at,
  };
}

// Resolves the guest scope once per request. Returns `ids: null` for non-guest
// callers (admin/set_leader/member get no extra `link_entity_id` filtering),
// and the scoped id list for guests (possibly empty). Callers must treat
// `dbError: true` as a 500.
async function resolveGuestScope(
  supabase: SupabaseClient<Database>,
  ctx: AuthContext,
): Promise<{ ids: string[] | null; dbError: boolean }> {
  if (ctx.role !== "guest") {
    return { ids: null, dbError: false };
  }
  const scope = await getGuestInboxLinkEntityIds(supabase, ctx.userId);
  return { ids: scope.linkEntityIds, dbError: scope.dbError };
}

// GET /api/notifications — the caller's own paginated in-app notification inbox
// (#71, PRD §22.12). Auth is "Any" (all 4 roles including guest); there is no
// requireRole gate. Guest visibility is narrowed to notifications linked to
// their own invitations / invited weeks / those weeks' setlists.
export async function listNotifications(
  req: NextRequest,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const parsedResult = listNotificationsQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const { page, pageSize } = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const scope = await resolveGuestScope(supabase, ctx);
    if (scope.dbError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (scope.ids !== null && scope.ids.length === 0) {
      return ok({
        notifications: [],
        pagination: { page, pageSize, total: 0 },
      });
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = supabase
      .from("notifications")
      .select(COLUMNS, { count: "exact" })
      .eq("user_id", ctx.userId)
      .eq("church_group_id", ctx.churchGroupId);
    if (scope.ids !== null) {
      query = query.in("link_entity_id", scope.ids);
    }

    const { data, error, count } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }) // stable tiebreak for identical timestamps
      .range(from, to);

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const notifications: NotificationItem[] = (
      (data ?? []) as NotificationQueryRow[]
    ).map(mapRow);

    return ok({
      notifications,
      pagination: { page, pageSize, total: count ?? 0 },
    });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// GET /api/notifications/unread-count — count of the caller's unread
// notifications (same scoping rules as listNotifications).
export async function getUnreadNotificationCount(
  req: NextRequest,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const scope = await resolveGuestScope(supabase, ctx);
    if (scope.dbError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (scope.ids !== null && scope.ids.length === 0) {
      return ok({ unreadCount: 0 });
    }

    let query = supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ctx.userId)
      .eq("church_group_id", ctx.churchGroupId)
      .eq("is_read", false);
    if (scope.ids !== null) {
      query = query.in("link_entity_id", scope.ids);
    }

    const { error, count } = await query;

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ unreadCount: count ?? 0 });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// PATCH /api/notifications/:id/read — mark one notification read. Idempotent:
// an already-read row is returned unchanged with 200 (never 409). A missing
// row, a row owned by another user, or a row outside a guest's scope all return
// 404 NOT_FOUND with an identical message (no existence leak, never 403).
export async function markNotificationRead(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const parsedId = notificationIdParamSchema.safeParse(id);
    if (!parsedId.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const scope = await resolveGuestScope(supabase, ctx);
    if (scope.dbError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const { data: existing, error: selectError } = await supabase
      .from("notifications")
      .select(COLUMNS)
      .eq("id", id)
      .eq("user_id", ctx.userId)
      .eq("church_group_id", ctx.churchGroupId)
      .maybeSingle();

    if (selectError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!existing) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    const existingRow = existing as NotificationQueryRow;

    if (scope.ids !== null) {
      if (
        existingRow.link_entity_id === null ||
        !scope.ids.includes(existingRow.link_entity_id)
      ) {
        return fail("Not found", ErrorCode.NOT_FOUND, 404);
      }
    }

    if (existingRow.is_read) {
      return ok({ notification: mapRow(existingRow) });
    }

    const patch: Database["public"]["Tables"]["notifications"]["Update"] = {
      is_read: true,
    };
    const { data: updated, error: updateError } = await supabase
      .from("notifications")
      .update(patch)
      .eq("id", id)
      .eq("user_id", ctx.userId)
      .eq("church_group_id", ctx.churchGroupId)
      .select(COLUMNS)
      .maybeSingle();

    if (updateError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (!updated) {
      return fail("Not found", ErrorCode.NOT_FOUND, 404);
    }

    return ok({ notification: mapRow(updated as NotificationQueryRow) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/notifications/mark-all-read — mark every unread notification in the
// caller's (scoped) inbox as read. Returns how many rows were flipped.
export async function markAllNotificationsRead(
  req: NextRequest,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const scope = await resolveGuestScope(supabase, ctx);
    if (scope.dbError) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }
    if (scope.ids !== null && scope.ids.length === 0) {
      return ok({ updatedCount: 0 });
    }

    const patch: Database["public"]["Tables"]["notifications"]["Update"] = {
      is_read: true,
    };
    let query = supabase
      .from("notifications")
      .update(patch)
      .eq("user_id", ctx.userId)
      .eq("church_group_id", ctx.churchGroupId)
      .eq("is_read", false);
    if (scope.ids !== null) {
      query = query.in("link_entity_id", scope.ids);
    }

    const { data, error } = await query.select("id");

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ updatedCount: (data ?? []).length });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
