jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/r2/client", () => ({ getUploadUrl: jest.fn(), getDownloadUrl: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getUploadUrl, getDownloadUrl } from "@/lib/r2/client";
import {
  createUploadUrl,
  registerDocument,
  listDocuments,
  deleteDocument,
  type SongDocumentResponse,
} from "@/app/api/songs/[id]/documents/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockGetUploadUrl = getUploadUrl as unknown as jest.Mock;
const mockGetDownloadUrl = getDownloadUrl as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const SONG_ID = "song-1";
const DOC_ID = "doc-1";

function makeReq(body?: unknown): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams() },
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeLookup(role: UserRole): UserLookup {
  const ctx: AuthContext = {
    userId: USER_ID,
    churchGroupId: CHURCH_GROUP_ID,
    role,
  };
  return async () => ctx;
}

function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

type QueryResult = { data: unknown; error: unknown };

// Generic chainable mock covering:
//   .select(...).eq(...).eq(...).maybeSingle()          (song-in-group check)
//   .select(...).eq(...).eq(...).order(...)              (list)
//   .insert(...).select(...).single()                    (register)
//   .delete().eq(...).eq(...).eq(...).select(...)        (delete)
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    or: jest.fn(() => chain),
    order: jest.fn(() => chain),
    select: jest.fn(() => chain),
    single: jest.fn(() => Promise.resolve(result)),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

const defaultDocRows = [
  {
    id: "doc-1",
    song_id: SONG_ID,
    name: "Lead Sheet.pdf",
    file_key: `song-documents/${CHURCH_GROUP_ID}/${SONG_ID}/uuid-1/Lead_Sheet.pdf`,
    file_type: "application/pdf",
    file_size_bytes: 1024,
    uploaded_by: "user-2",
    created_at: "2026-07-01T00:00:00.000Z",
  },
];

const insertedDocRow = {
  id: "doc-new",
  song_id: SONG_ID,
  name: "Chart.pdf",
  file_key: `song-documents/${CHURCH_GROUP_ID}/${SONG_ID}/uuid-2/Chart.pdf`,
  file_type: "application/pdf",
  file_size_bytes: 2048,
  uploaded_by: USER_ID,
  created_at: "2026-07-10T00:00:00.000Z",
};

type Fixtures = {
  songExists: QueryResult;
  list: QueryResult;
  insert: QueryResult;
  delete: QueryResult;
};

const DEFAULT_FIXTURES: Fixtures = {
  songExists: { data: { id: SONG_ID }, error: null },
  list: { data: defaultDocRows, error: null },
  insert: { data: insertedDocRow, error: null },
  delete: { data: [{ id: DOC_ID }], error: null },
};

function makeSupabaseClient(
  overrides: Partial<Fixtures> = {},
  hooks?: { onInsert?: (table: string, payload: unknown) => void },
) {
  const fixtures: Fixtures = { ...DEFAULT_FIXTURES, ...overrides };

  return {
    from: jest.fn((table: string) => {
      if (table === "songs") {
        return {
          select: jest.fn(() => makeChain(fixtures.songExists)),
        };
      }
      if (table === "song_documents") {
        return {
          select: jest.fn(() => makeChain(fixtures.list)),
          insert: jest.fn((payload: unknown) => {
            hooks?.onInsert?.(table, payload);
            return makeChain(fixtures.insert);
          }),
          delete: jest.fn(() => makeChain(fixtures.delete)),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockGetUploadUrl.mockReset();
  mockGetDownloadUrl.mockReset();
  mockGetUploadUrl.mockResolvedValue("https://r2.example/upload-signed");
  mockGetDownloadUrl.mockResolvedValue("https://r2.example/download-signed");
});

describe("POST /api/songs/:id/documents/upload-url", () => {
  const validBody = { name: "Chart.pdf", file_type: "application/pdf", file_size_bytes: 2048 };

  it("returns 200 with uploadUrl and a server-minted fileKey for admin/set_leader", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createUploadUrl(makeReq(validBody), SONG_ID, makeLookup("set_leader"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.uploadUrl).toBe("https://r2.example/upload-signed");
    expect(body.data.fileKey).toMatch(
      new RegExp(`^song-documents/${CHURCH_GROUP_ID}/${SONG_ID}/[^/]+/Chart\\.pdf$`),
    );
    expect(mockGetUploadUrl).toHaveBeenCalledWith(body.data.fileKey, "application/pdf");
  });

  it("sanitizes unsafe characters out of the file name in fileKey", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createUploadUrl(
      makeReq({ ...validBody, name: "My Chart (final)!.pdf" }),
      SONG_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.fileKey).toMatch(/My_Chart__final__\.pdf$/);
  });

  it("returns 400 VALIDATION_FAILED for a missing/malformed body", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createUploadUrl(makeReq(null), SONG_ID, makeLookup("admin"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it.each([0, -1, 1.5, "2048"])(
    "returns 400 for an invalid file_size_bytes value: %p",
    async (file_size_bytes) => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

      const res = await createUploadUrl(
        makeReq({ ...validBody, file_size_bytes }),
        SONG_ID,
        makeLookup("admin"),
      );
      expect(res.status).toBe(400);
    },
  );

  it("returns 404 NOT_FOUND when the song is not in the caller's group", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ songExists: { data: null, error: null } }),
    );

    const res = await createUploadUrl(makeReq(validBody), SONG_ID, makeLookup("admin"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(mockGetUploadUrl).not.toHaveBeenCalled();
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for role = '%s'", async (role) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createUploadUrl(makeReq(validBody), SONG_ID, makeLookup(role));
    expect(res.status).toBe(403);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await createUploadUrl(makeReq(validBody), SONG_ID, makeLookup("admin"));
    expect(res.status).toBe(401);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the R2 helper throws", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());
    mockGetUploadUrl.mockRejectedValue(new Error("missing R2 env vars"));

    const res = await createUploadUrl(makeReq(validBody), SONG_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("POST /api/songs/:id/documents", () => {
  const validFileKey = `song-documents/${CHURCH_GROUP_ID}/${SONG_ID}/uuid-2/Chart.pdf`;
  const validBody = {
    name: "Chart.pdf",
    file_type: "application/pdf",
    file_size_bytes: 2048,
    file_key: validFileKey,
  };

  it("returns 201 with the full document DTO (incl. downloadUrl, no file_key) for admin/set_leader", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({}, { onInsert: (_table, payload) => (capturedPayload = payload) }),
    );

    const res = await registerDocument(makeReq(validBody), SONG_ID, makeLookup("set_leader"));
    expect(res.status).toBe(201);

    const body = await res.json();
    const document: SongDocumentResponse = body.data.document;
    expect(document).toEqual({
      id: insertedDocRow.id,
      songId: SONG_ID,
      name: insertedDocRow.name,
      fileType: insertedDocRow.file_type,
      fileSizeBytes: insertedDocRow.file_size_bytes,
      uploadedBy: insertedDocRow.uploaded_by,
      createdAt: insertedDocRow.created_at,
      downloadUrl: "https://r2.example/download-signed",
    });
    expect(document).not.toHaveProperty("fileKey");
    expect(document).not.toHaveProperty("file_key");

    expect(capturedPayload).toMatchObject({
      song_id: SONG_ID,
      church_group_id: CHURCH_GROUP_ID,
      name: "Chart.pdf",
      file_key: validFileKey,
      file_type: "application/pdf",
      file_size_bytes: 2048,
      uploaded_by: USER_ID,
    });
    expect(mockGetDownloadUrl).toHaveBeenCalledWith(insertedDocRow.file_key);
  });

  it("returns 400 VALIDATION_FAILED for a missing/malformed body", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await registerDocument(makeReq(null), SONG_ID, makeLookup("admin"));
    expect(res.status).toBe(400);
  });

  it.each([
    "not-prefixed/at/all.pdf",
    `song-documents/other-group/${SONG_ID}/uuid/Chart.pdf`,
    `song-documents/${CHURCH_GROUP_ID}/other-song/uuid/Chart.pdf`,
  ])("returns 400 VALIDATION_FAILED when file_key is not scoped to group+song: %s", async (file_key) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await registerDocument(
      makeReq({ ...validBody, file_key }),
      SONG_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 404 NOT_FOUND when the song is not in the caller's group", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ songExists: { data: null, error: null } }),
    );

    const res = await registerDocument(makeReq(validBody), SONG_ID, makeLookup("admin"));
    expect(res.status).toBe(404);
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for role = '%s'", async (role) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await registerDocument(makeReq(validBody), SONG_ID, makeLookup(role));
    expect(res.status).toBe(403);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await registerDocument(makeReq(validBody), SONG_ID, makeLookup("admin"));
    expect(res.status).toBe(401);
  });

  it("returns 500 INTERNAL when the insert errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ insert: { data: null, error: { message: "constraint violation" } } }),
    );

    const res = await registerDocument(makeReq(validBody), SONG_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("GET /api/songs/:id/documents", () => {
  it("returns 200 with documents (incl. downloadUrl, no file_key) for admin/set_leader/member", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await listDocuments(makeReq(), SONG_ID, makeLookup("member"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const documents: SongDocumentResponse[] = body.data.documents;
    expect(documents).toEqual([
      {
        id: "doc-1",
        songId: SONG_ID,
        name: "Lead Sheet.pdf",
        fileType: "application/pdf",
        fileSizeBytes: 1024,
        uploadedBy: "user-2",
        createdAt: "2026-07-01T00:00:00.000Z",
        downloadUrl: "https://r2.example/download-signed",
      },
    ]);
    expect(documents[0]).not.toHaveProperty("fileKey");
  });

  it("returns 200 with an empty array when the song has no documents", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ list: { data: [], error: null } }),
    );

    const res = await listDocuments(makeReq(), SONG_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.documents).toEqual([]);
  });

  it("returns 404 NOT_FOUND when the song is not in the caller's group", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ songExists: { data: null, error: null } }),
    );

    const res = await listDocuments(makeReq(), SONG_ID, makeLookup("admin"));
    expect(res.status).toBe(404);
  });

  it("returns 403 FORBIDDEN for a guest", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await listDocuments(makeReq(), SONG_ID, makeLookup("guest"));
    expect(res.status).toBe(403);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await listDocuments(makeReq(), SONG_ID, makeLookup("member"));
    expect(res.status).toBe(401);
  });

  it("returns 500 INTERNAL when the query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ list: { data: null, error: { message: "connection refused" } } }),
    );

    const res = await listDocuments(makeReq(), SONG_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("DELETE /api/songs/:id/documents/:docId", () => {
  it("returns 200 with { success: true } for admin/set_leader", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await deleteDocument(makeReq(), SONG_ID, DOC_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ success: true });
  });

  it("returns 404 NOT_FOUND when no row matches the scoped delete", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ delete: { data: [], error: null } }),
    );

    const res = await deleteDocument(makeReq(), SONG_ID, DOC_ID, makeLookup("admin"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 404 NOT_FOUND when the song is not in the caller's group", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ songExists: { data: null, error: null } }),
    );

    const res = await deleteDocument(makeReq(), SONG_ID, DOC_ID, makeLookup("admin"));
    expect(res.status).toBe(404);
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for role = '%s'", async (role) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await deleteDocument(makeReq(), SONG_ID, DOC_ID, makeLookup(role));
    expect(res.status).toBe(403);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await deleteDocument(makeReq(), SONG_ID, DOC_ID, makeLookup("admin"));
    expect(res.status).toBe(401);
  });

  it("returns 500 INTERNAL when the delete errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ delete: { data: null, error: { message: "connection refused" } } }),
    );

    const res = await deleteDocument(makeReq(), SONG_ID, DOC_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
