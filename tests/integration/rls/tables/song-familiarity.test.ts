/**
 * song_familiarity RLS tests — issue #221, P2-14 (decision D7).
 * Members read/write only their own rows; leaders and admins read the group's
 * but cannot write others'; guests have no access; no cross-church access.
 */

import { getUserClient, getServiceClient } from "../client";
import { IDS, rlsTestsEnabled, seedViaServiceClient } from "../setup";
import { assertSelectAllowed, assertSelectBlocked, assertInsertDenied, assertUpdateNoOp, assertDeleteNoOp } from "../helpers";

const skip = !rlsTestsEnabled || !process.env.SUPABASE_TEST_URL;
const describeRls = skip ? describe.skip : describe;

const P = "00000000-0000-4000-8018-";
const SONG_A = `${P}000000000001`;
const SONG_B = `${P}000000000002`;
const FAM_MEMBER = `${P}000000000011`;
const FAM_MEMBER2 = `${P}000000000012`;
const FAM_B = `${P}000000000013`;

describeRls("song_familiarity", () => {
  let svc: ReturnType<typeof getServiceClient>;
  let memberA: ReturnType<typeof getUserClient>;
  let memberA2: ReturnType<typeof getUserClient>;
  let leaderA: ReturnType<typeof getUserClient>;
  let adminA: ReturnType<typeof getUserClient>;
  let guestA: ReturnType<typeof getUserClient>;
  let memberB: ReturnType<typeof getUserClient>;
  const A = IDS.churches.A;
  const B = IDS.churches.B;
  const U = IDS.users;

  beforeAll(async () => {
    await seedViaServiceClient();
    svc = getServiceClient();
    memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
    memberA2 = getUserClient({ clerkId: IDS.clerkIds.memberA2 });
    leaderA = getUserClient({ clerkId: IDS.clerkIds.leaderA });
    adminA = getUserClient({ clerkId: IDS.clerkIds.adminA });
    guestA = getUserClient({ clerkId: IDS.clerkIds.guestA });
    memberB = getUserClient({ clerkId: IDS.clerkIds.memberB });

    const songs = await svc.from("songs").insert([
      { id: SONG_A, church_group_id: A, title: "Familiarity Song A" },
      { id: SONG_B, church_group_id: B, title: "Familiarity Song B" },
    ]);
    if (songs.error) throw new Error(songs.error.message);
    const fam = await svc.from("song_familiarity").insert([
      { id: FAM_MEMBER, church_group_id: A, user_id: U.memberA, song_id: SONG_A, level: "learning" },
      { id: FAM_MEMBER2, church_group_id: A, user_id: U.memberA2, song_id: SONG_A, level: "comfortable" },
      { id: FAM_B, church_group_id: B, user_id: U.memberB, song_id: SONG_B, level: "learning" },
    ]);
    if (fam.error) throw new Error(fam.error.message);
  }, 60_000);

  afterAll(async () => {
    if (!svc) return;
    await svc.from("songs").delete().in("id", [SONG_A, SONG_B]); // cascades to familiarity rows
  });

  it("a member reads their own row but not another member's", async () => {
    await assertSelectAllowed(memberA, "song_familiarity", { id: FAM_MEMBER });
    await assertSelectBlocked(memberA, "song_familiarity", { id: FAM_MEMBER2 });
    await assertSelectBlocked(memberA2, "song_familiarity", { id: FAM_MEMBER });
  });

  it("leaders and admins read the whole group's rows", async () => {
    for (const c of [leaderA, adminA]) {
      await assertSelectAllowed(c, "song_familiarity", { id: FAM_MEMBER });
      await assertSelectAllowed(c, "song_familiarity", { id: FAM_MEMBER2 });
    }
  });

  it("guests and other churches read nothing", async () => {
    await assertSelectBlocked(guestA, "song_familiarity", { id: FAM_MEMBER });
    await assertSelectBlocked(memberB, "song_familiarity", { id: FAM_MEMBER });
    await assertSelectBlocked(memberA, "song_familiarity", { id: FAM_B });
    await assertSelectBlocked(adminA, "song_familiarity", { id: FAM_B });
  });

  it("a member can upsert their own level (insert then update)", async () => {
    const mine = { church_group_id: A, user_id: U.memberA2, song_id: SONG_A };
    const { error } = await memberA2
      .from("song_familiarity")
      .upsert({ ...mine, level: "not_learned" }, { onConflict: "user_id,song_id" });
    expect(error).toBeNull();
    const { data } = await svc.from("song_familiarity").select("level").eq("id", FAM_MEMBER2).single();
    expect(data?.level).toBe("not_learned");
  });

  it("nobody writes for someone else or into another group, including leaders and admins", async () => {
    const row = (over: Record<string, unknown>) => ({
      church_group_id: A,
      user_id: U.memberA,
      song_id: SONG_A,
      level: "comfortable",
      ...over,
    });
    await assertInsertDenied(memberA2, "song_familiarity", row({ user_id: U.memberA }));
    await assertInsertDenied(leaderA, "song_familiarity", row({}));
    await assertInsertDenied(adminA, "song_familiarity", row({}));
    await assertInsertDenied(guestA, "song_familiarity", row({ user_id: U.guestA }));
    await assertUpdateNoOp(memberA2, svc, "song_familiarity", FAM_MEMBER, { level: "comfortable" });
    await assertUpdateNoOp(leaderA, svc, "song_familiarity", FAM_MEMBER, { level: "comfortable" });
    await assertUpdateNoOp(adminA, svc, "song_familiarity", FAM_MEMBER, { level: "comfortable" });
  });

  it("a song from another church cannot be marked", async () => {
    await assertInsertDenied(memberA, "song_familiarity", {
      church_group_id: A,
      user_id: U.memberA,
      song_id: SONG_B,
      level: "learning",
    });
    await assertInsertDenied(memberA, "song_familiarity", {
      church_group_id: B,
      user_id: U.memberA,
      song_id: SONG_B,
      level: "learning",
    });
  });

  it("an invalid level is rejected", async () => {
    const { error } = await memberA
      .from("song_familiarity")
      .update({ level: "expert" } as never)
      .eq("id", FAM_MEMBER);
    expect(error).not.toBeNull();
  });

  it("only the owner can delete their row", async () => {
    await assertDeleteNoOp(memberA2, svc, "song_familiarity", FAM_MEMBER);
    await assertDeleteNoOp(adminA, svc, "song_familiarity", FAM_MEMBER);
    const { error } = await memberA.from("song_familiarity").delete().eq("id", FAM_MEMBER);
    expect(error).toBeNull();
    const { data } = await svc.from("song_familiarity").select("id").eq("id", FAM_MEMBER);
    expect(data).toHaveLength(0);
  });
});
