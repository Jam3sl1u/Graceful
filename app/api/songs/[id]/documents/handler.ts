import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, requireRole, type UserLookup, type AuthContext } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { getUploadUrl, getDownloadUrl } from "@/lib/r2/client";
import { uploadUrlSchema, registerDocumentSchema } from "@/schemas/song-documents";

export type SongDocumentResponse = {
  id: string;
  songId: string;
  name: string;
  fileType: string;
  fileSizeBytes: number;
  uploadedBy: string | null;
  createdAt: string;
  downloadUrl: string; // presigned GET, 30-min expiry
};

type SongDocumentRow = {
  id: string;
  song_id: string;
  name: string;
  file_key: string;
  file_type: string;
  file_size_bytes: number;
  uploaded_by: string | null;
  created_at: string;
};

async function toSongDocumentResponse(row: SongDocumentRow): Promise<SongDocumentResponse> {
  const downloadUrl = await getDownloadUrl(row.file_key);
  return {
    id: row.id,
    songId: row.song_id,
    name: row.name,
    fileType: row.file_type,
    fileSizeBytes: row.file_size_bytes,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    downloadUrl,
  };
}

// Verifies songId exists within the caller's church group, using the
// RLS-scoped client. Returns true if found.
async function songExistsInGroup(
  supabase: ReturnType<typeof getSupabaseClient>,
  songId: string,
  ctx: AuthContext,
): Promise<boolean> {
  const { data } = await supabase
    .from("songs")
    .select("id")
    .eq("id", songId)
    .eq("church_group_id", ctx.churchGroupId)
    .maybeSingle();
  return !!data;
}

// POST /api/songs/:id/documents/upload-url — Set Leader / Admin requests a
// presigned PUT URL to upload a song document to R2. Server mints the
// file_key; the client never chooses it.
export async function createUploadUrl(
  req: NextRequest,
  songId: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const body = await req.json().catch(() => null);
    const parsedResult = uploadUrlSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const input = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    if (!(await songExistsInGroup(supabase, songId, ctx))) {
      return fail("Song not found", ErrorCode.NOT_FOUND, 404);
    }

    const safeName = input.name.replace(/[^A-Za-z0-9._-]/g, "_");
    const fileKey = `song-documents/${ctx.churchGroupId}/${songId}/${crypto.randomUUID()}/${safeName}`;

    const uploadUrl = await getUploadUrl(fileKey, input.file_type);

    return ok({ uploadUrl, fileKey }, 200);
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// POST /api/songs/:id/documents — Set Leader / Admin registers a document
// that has already been PUT to R2 via the upload-url flow.
export async function registerDocument(
  req: NextRequest,
  songId: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader"]);

    const body = await req.json().catch(() => null);
    const parsedResult = registerDocumentSchema.safeParse(body);
    if (!parsedResult.success) {
      return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);
    }
    const input = parsedResult.data;

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    if (!(await songExistsInGroup(supabase, songId, ctx))) {
      return fail("Song not found", ErrorCode.NOT_FOUND, 404);
    }

    if (!input.file_key.startsWith(`song-documents/${ctx.churchGroupId}/${songId}/`)) {
      return fail("Invalid file key", ErrorCode.VALIDATION_FAILED, 400);
    }

    const payload = {
      song_id: songId,
      church_group_id: ctx.churchGroupId,
      name: input.name,
      file_key: input.file_key,
      file_type: input.file_type,
      file_size_bytes: input.file_size_bytes,
      uploaded_by: ctx.userId,
    } as unknown as Database["public"]["Tables"]["song_documents"]["Insert"];

    const { data, error } = await supabase
      .from("song_documents")
      .insert(payload)
      .select("id, song_id, name, file_key, file_type, file_size_bytes, uploaded_by, created_at")
      .single();

    if (error || !data) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const document = await toSongDocumentResponse(data);
    return ok({ document }, 201);
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// GET /api/songs/:id/documents — list a song's documents with fresh
// presigned download URLs. Musicians (member) must be able to read charts;
// guests are excluded.
export async function listDocuments(
  req: NextRequest,
  songId: string,
  lookup?: UserLookup,
): Promise<Response> {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin", "set_leader", "member"]);

    const { getToken } = await auth();
    const jwt = await getToken({ template: "supabase" });
    if (!jwt) {
      return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
    }
    const supabase = getSupabaseClient(jwt);

    if (!(await songExistsInGroup(supabase, songId, ctx))) {
      return fail("Song not found", ErrorCode.NOT_FOUND, 404);
    }

    const { data, error } = await supabase
      .from("song_documents")
      .select("id, song_id, name, file_key, file_type, file_size_bytes, uploaded_by, created_at")
      .eq("song_id", songId)
      .eq("church_group_id", ctx.churchGroupId)
      .order("created_at", { ascending: true });

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    const documents = await Promise.all((data ?? []).map(toSongDocumentResponse));

    return ok({ documents }, 200);
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}

// DELETE /api/songs/:id/documents/:docId — Set Leader / Admin removes a
// document's metadata row. R2 object cleanup is out of scope (see spec).
export async function deleteDocument(
  req: NextRequest,
  songId: string,
  docId: string,
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

    if (!(await songExistsInGroup(supabase, songId, ctx))) {
      return fail("Song not found", ErrorCode.NOT_FOUND, 404);
    }

    const { data, error } = await supabase
      .from("song_documents")
      .delete()
      .eq("id", docId)
      .eq("song_id", songId)
      .eq("church_group_id", ctx.churchGroupId)
      .select("id");

    if (error) {
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    if (!data || data.length === 0) {
      return fail("Document not found", ErrorCode.NOT_FOUND, 404);
    }

    return ok({ success: true }, 200);
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
