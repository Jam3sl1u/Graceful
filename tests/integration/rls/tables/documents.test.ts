/**
 * documents (general shared library) RLS tests — issue #216, P2-09.
 *
 * Members, set leaders and admins read their own church group's documents;
 * only admins add or remove; guests have no access; rows are immutable.
 * Private fixtures use the 00000000-0000-4000-8017-* ID range.
 */

import { getUserClient, getServiceClient } from "../client";
import { IDS, rlsTestsEnabled, seedViaServiceClient } from "../setup";
import {
  assertSelectAllowed,
  assertSelectBlocked,
  assertInsertDenied,
  assertUpdateNoOp,
  assertDeleteNoOp,
} from "../helpers";

const skip = !rlsTestsEnabled || !process.env.SUPABASE_TEST_URL;
const describeRls = skip ? describe.skip : describe;

const P = "00000000-0000-4000-8017-";
const DOC_A = `${P}000000000001`;
const DOC_B = `${P}000000000002`;
const DOC_A_DELETE = `${P}000000000003`;

describeRls("documents — general shared library", () => {
  let svc: ReturnType<typeof getServiceClient>;
  let adminA: ReturnType<typeof getUserClient>;
  let leaderA: ReturnType<typeof getUserClient>;
  let memberA: ReturnType<typeof getUserClient>;
  let guestA: ReturnType<typeof getUserClient>;
  let memberB: ReturnType<typeof getUserClient>;
  let adminB: ReturnType<typeof getUserClient>;

  const A = IDS.churches.A;
  const B = IDS.churches.B;
  const U = IDS.users;

  const doc = (over: Record<string, unknown> = {}) => ({
    church_group_id: A,
    name: "Training guide",
    file_key: `documents/${A}/${Date.now()}-${Math.random()}.pdf`,
    file_type: "application/pdf",
    file_size_bytes: 1024,
    folder: "Training",
    uploaded_by: U.adminA,
    ...over,
  });

  beforeAll(async () => {
    await seedViaServiceClient();
    svc = getServiceClient();
    adminA = getUserClient({ clerkId: IDS.clerkIds.adminA });
    leaderA = getUserClient({ clerkId: IDS.clerkIds.leaderA });
    memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
    guestA = getUserClient({ clerkId: IDS.clerkIds.guestA });
    memberB = getUserClient({ clerkId: IDS.clerkIds.memberB });
    adminB = getUserClient({ clerkId: IDS.clerkIds.adminB });

    const { error } = await svc.from("documents").insert([
      doc({ id: DOC_A, file_key: "documents/test/a.pdf" }),
      doc({ id: DOC_A_DELETE, file_key: "documents/test/a-delete.pdf" }),
      doc({ id: DOC_B, church_group_id: B, uploaded_by: U.adminB, file_key: "documents/test/b.pdf" }),
    ]);
    if (error) throw new Error(`fixture insert into documents failed: ${error.message}`);
  }, 60_000);

  afterAll(async () => {
    if (!svc) return;
    await svc.from("documents").delete().in("id", [DOC_A, DOC_B, DOC_A_DELETE]);
    await svc.from("documents").delete().like("file_key", `documents/${A}/%`);
  });

  it("members, set leaders and admins read their own group's documents", async () => {
    for (const c of [memberA, leaderA, adminA]) {
      await assertSelectAllowed(c, "documents", { id: DOC_A });
    }
  });

  it("guests cannot read the general library", async () => {
    await assertSelectBlocked(guestA, "documents", { id: DOC_A });
    await assertSelectBlocked(guestA, "documents", { church_group_id: A });
  });

  it("no one reads another church group's documents", async () => {
    for (const c of [memberA, leaderA, adminA]) {
      await assertSelectBlocked(c, "documents", { id: DOC_B });
    }
    for (const c of [memberB, adminB]) {
      await assertSelectBlocked(c, "documents", { id: DOC_A });
    }
  });

  it("only an admin can insert, as themselves, into their own group", async () => {
    const { error } = await adminA.from("documents").insert(doc());
    expect(error).toBeNull();

    await assertInsertDenied(memberA, "documents", doc({ uploaded_by: U.memberA }));
    await assertInsertDenied(leaderA, "documents", doc({ uploaded_by: U.leaderA }));
    await assertInsertDenied(guestA, "documents", doc({ uploaded_by: U.guestA }));
    // An admin cannot attribute an upload to someone else or write into another group.
    await assertInsertDenied(adminA, "documents", doc({ uploaded_by: U.memberA }));
    await assertInsertDenied(adminA, "documents", doc({ church_group_id: B }));
    await assertInsertDenied(adminB, "documents", doc({ uploaded_by: U.adminB }));
  });

  it("rejects blank names, blank folders, non-positive sizes and duplicate file keys", async () => {
    await assertInsertDenied(adminA, "documents", doc({ name: "   " }));
    await assertInsertDenied(adminA, "documents", doc({ folder: "" }));
    await assertInsertDenied(adminA, "documents", doc({ file_size_bytes: 0 }));
    await assertInsertDenied(adminA, "documents", doc({ file_key: "documents/test/a.pdf" }));
  });

  it("documents are immutable, even for admins", async () => {
    await assertUpdateNoOp(adminA, svc, "documents", DOC_A, { name: "Renamed" });
    await assertUpdateNoOp(adminA, svc, "documents", DOC_A, { file_key: "documents/test/other.pdf" });
    await assertUpdateNoOp(memberA, svc, "documents", DOC_A, { folder: "General" });
  });

  it("only an admin of the same group can delete", async () => {
    for (const c of [memberA, leaderA, guestA, adminB]) {
      await assertDeleteNoOp(c, svc, "documents", DOC_A_DELETE);
    }
    const { error } = await adminA.from("documents").delete().eq("id", DOC_A_DELETE);
    expect(error).toBeNull();
    const { data } = await svc.from("documents").select("id").eq("id", DOC_A_DELETE);
    expect(data).toHaveLength(0);
  });
});
