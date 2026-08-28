import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { createInstrumentSchema } from "@/schemas/instruments";

export type InstrumentResponse = {
  id: string;
  name: string;
  isDefault: boolean;
  pending: boolean; // = !isDefault
  createdBy: string | null;
};

function toInstrumentResponse(row: {
  id: string;
  name: string;
  is_default: boolean;
  created_by: string | null;
}): InstrumentResponse {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default,
    pending: !row.is_default,
    createdBy: row.created_by,
  };
}

// GET /api/instruments — the group's full instrument catalog (defaults +
// custom/pending), any authenticated member.
export async function listInstruments(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data, error } = await supabase
      .from("instruments")
      .select("id, name, is_default, created_by")
      .eq("church_group_id", ctx.churchGroupId)
      .order("is_default", { ascending: false })
      .order("name", { ascending: true });

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ instruments: (data ?? []).map(toInstrumentResponse) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/instruments — admin adds a default (is_default: true) instrument
// to the group's catalog.
export async function addInstrument(req: NextRequest, lookup?: UserLookup): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin"]);

    const body = await req.json().catch(() => null);
    const parsedResult = createInstrumentSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const parsed = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data: existing, error: dupErr } = await supabase
      .from("instruments")
      .select("name")
      .eq("church_group_id", ctx.churchGroupId);
    if (dupErr) return fail("Internal error", ErrorCode.INTERNAL, 500);
    if ((existing ?? []).some((r) => r.name.trim().toLowerCase() === parsed.name.toLowerCase())) {
      return fail("Instrument already exists", ErrorCode.CONFLICT, 409);
    }

    // The hand-rolled Insert type in lib/supabase/types.ts marks `created_at`
    // as required even though the DB column has a `now()` default (it isn't
    // generated from the live schema). Cast narrowly here rather than
    // widening the shared type or setting a value for a column we must not
    // touch.
    const payload = {
      church_group_id: ctx.churchGroupId,
      name: parsed.name,
      is_default: true,
      created_by: ctx.userId,
    } as unknown as Database["public"]["Tables"]["instruments"]["Insert"];

    const { data, error } = await supabase
      .from("instruments")
      .insert(payload)
      .select("id, name, is_default, created_by")
      .single();

    if (error || !data) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ instrument: toInstrumentResponse(data) }, 201);
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/instruments/custom — any member submits a custom (pending,
// is_default: false) instrument to the group's catalog.
export async function submitCustomInstrument(
  req: NextRequest,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);

    const body = await req.json().catch(() => null);
    const parsedResult = createInstrumentSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const parsed = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data: existing, error: dupErr } = await supabase
      .from("instruments")
      .select("name")
      .eq("church_group_id", ctx.churchGroupId);
    if (dupErr) return fail("Internal error", ErrorCode.INTERNAL, 500);
    if ((existing ?? []).some((r) => r.name.trim().toLowerCase() === parsed.name.toLowerCase())) {
      return fail("Instrument already exists", ErrorCode.CONFLICT, 409);
    }

    const payload = {
      church_group_id: ctx.churchGroupId,
      name: parsed.name,
      is_default: false,
      created_by: ctx.userId,
    } as unknown as Database["public"]["Tables"]["instruments"]["Insert"];

    const { data, error } = await supabase
      .from("instruments")
      .insert(payload)
      .select("id, name, is_default, created_by")
      .single();

    if (error || !data) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok({ instrument: toInstrumentResponse(data) }, 201);
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/instruments/[id]/promote — admin marks a pending/custom
// instrument as a group default (is_default: true). Idempotent.
export async function promoteInstrument(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin"]);

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data, error } = await supabase
      .from("instruments")
      .update({
        is_default: true,
      } as unknown as Database["public"]["Tables"]["instruments"]["Update"])
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .select("id, name, is_default, created_by");

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const [row] = data ?? [];
    if (!row) {
      return fail("Instrument not found", ErrorCode.NOT_FOUND, 404);
    }

    return ok({ instrument: toInstrumentResponse(row) });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// DELETE /api/instruments/[id] — admin removes an instrument from the
// group's catalog. FK cascade auto-clears member_instruments.
export async function deleteInstrument(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin"]);

    const { getToken } = await auth();
    const jwt = await getToken();
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    const { data, error } = await supabase
      .from("instruments")
      .delete()
      .eq("id", id)
      .eq("church_group_id", ctx.churchGroupId)
      .select("id");

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const rows = data ?? [];
    if (rows.length === 0) {
      return fail("Instrument not found", ErrorCode.NOT_FOUND, 404);
    }

    return ok({ deleted: true });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
