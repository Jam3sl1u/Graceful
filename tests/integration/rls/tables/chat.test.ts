/**
 * Chat tables RLS tests (issue #208, P2-01).
 *
 * Membership rule (D2): a user is a member of a week's chat room iff the room
 * is in their church group and they are admin/set_leader OR hold an
 * 'accepted' invitation for the room's service week.
 *
 * Private fixtures use the 00000000-0000-4000-8016-* ID range so they never
 * collide with the shared seed. Mutating cases use their own messages/weeks.
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

const P = "00000000-0000-4000-8016-";
const F = {
  W1: `${P}000000000001`,
  W2: `${P}000000000002`,
  W3: `${P}000000000003`, // fresh week for room insert (leaderA)
  W4: `${P}000000000004`, // fresh week for room insert (memberA, denied)
  W5: `${P}000000000005`, // cascade test
  R1: `${P}000000000011`,
  R2: `${P}000000000012`,
  R5: `${P}000000000015`,
  M1: `${P}000000000021`,
  M2: `${P}000000000022`,
  M5: `${P}000000000025`,
};

describeRls("Chat tables — membership, archive, content and mention rules", () => {
  let svc: ReturnType<typeof getServiceClient>;
  let memberA: ReturnType<typeof getUserClient>;
  let memberA2: ReturnType<typeof getUserClient>;
  let guestA: ReturnType<typeof getUserClient>;
  let leaderA: ReturnType<typeof getUserClient>;
  let adminA: ReturnType<typeof getUserClient>;
  let memberB: ReturnType<typeof getUserClient>;
  let adminB: ReturnType<typeof getUserClient>;

  const A = IDS.churches.A;
  const U = IDS.users;

  async function mustInsert(table: string, rows: Record<string, unknown>[]) {
    const { error } = await svc.from(table).insert(rows);
    if (error) throw new Error(`fixture insert into ${table} failed: ${error.message}`);
  }

  beforeAll(async () => {
    await seedViaServiceClient();
    svc = getServiceClient();
    memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
    memberA2 = getUserClient({ clerkId: IDS.clerkIds.memberA2 });
    guestA = getUserClient({ clerkId: IDS.clerkIds.guestA });
    leaderA = getUserClient({ clerkId: IDS.clerkIds.leaderA });
    adminA = getUserClient({ clerkId: IDS.clerkIds.adminA });
    memberB = getUserClient({ clerkId: IDS.clerkIds.memberB });
    adminB = getUserClient({ clerkId: IDS.clerkIds.adminB });

    await mustInsert("service_weeks", [
      { id: F.W1, church_group_id: A, service_date: "2027-01-03", title: "Chat W1" },
      { id: F.W2, church_group_id: A, service_date: "2027-01-10", title: "Chat W2" },
      { id: F.W3, church_group_id: A, service_date: "2027-01-17", title: "Chat W3" },
      { id: F.W4, church_group_id: A, service_date: "2027-01-24", title: "Chat W4" },
      { id: F.W5, church_group_id: A, service_date: "2027-01-31", title: "Chat W5" },
    ]);
    await mustInsert("chat_rooms", [
      { id: F.R1, church_group_id: A, service_week_id: F.W1, is_archived: false },
      { id: F.R2, church_group_id: A, service_week_id: F.W2, is_archived: true },
      { id: F.R5, church_group_id: A, service_week_id: F.W5, is_archived: false },
    ]);
    await mustInsert("invitations", [
      { church_group_id: A, service_week_id: F.W1, user_id: U.memberA, status: "accepted", response_token: "chat-tok-w1-memberA" },
      { church_group_id: A, service_week_id: F.W1, user_id: U.guestA, status: "accepted", response_token: "chat-tok-w1-guestA" },
      { church_group_id: A, service_week_id: F.W1, user_id: U.memberA2, status: "pending", response_token: "chat-tok-w1-memberA2" },
      { church_group_id: A, service_week_id: F.W2, user_id: U.memberA, status: "accepted", response_token: "chat-tok-w2-memberA" },
      { church_group_id: A, service_week_id: F.W2, user_id: U.memberA2, status: "denied", response_token: "chat-tok-w2-memberA2" },
      { church_group_id: A, service_week_id: F.W5, user_id: U.memberA, status: "accepted", response_token: "chat-tok-w5-memberA" },
    ]);
    await mustInsert("chat_messages", [
      { id: F.M1, chat_room_id: F.R1, church_group_id: A, user_id: U.memberA, content: "M1" },
      { id: F.M2, chat_room_id: F.R2, church_group_id: A, user_id: U.memberA, content: "M2" },
      { id: F.M5, chat_room_id: F.R5, church_group_id: A, user_id: U.memberA, content: "M5" },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (!svc) return;
    await svc.from("service_weeks").delete().in("id", [F.W1, F.W2, F.W3, F.W4, F.W5]);
  });

  const msg = (over: Record<string, unknown> = {}) => ({
    chat_room_id: F.R1,
    church_group_id: A,
    user_id: U.memberA,
    content: "hello",
    ...over,
  });

  it("1. SELECT room R1 / message M1: members, guests, leaders, admins allowed; pending and other churches blocked", async () => {
    for (const c of [memberA, guestA, leaderA, adminA]) {
      await assertSelectAllowed(c, "chat_rooms", { id: F.R1 });
      await assertSelectAllowed(c, "chat_messages", { id: F.M1 });
    }
    for (const c of [memberA2, memberB, adminB]) {
      await assertSelectBlocked(c, "chat_rooms", { id: F.R1 });
      await assertSelectBlocked(c, "chat_messages", { id: F.M1 });
    }
  });

  it("2. archived room R2 stays readable for accepted member, blocked for denied invitee", async () => {
    await assertSelectAllowed(memberA, "chat_rooms", { id: F.R2 });
    await assertSelectBlocked(memberA2, "chat_rooms", { id: F.R2 });
  });

  it("3. INSERT message: accepted member allowed, pending invitee denied", async () => {
    const { error } = await memberA.from("chat_messages").insert(msg());
    expect(error).toBeNull();
    await assertInsertDenied(memberA2, "chat_messages", msg({ user_id: U.memberA2 }));
  });

  it("4. INSERT into archived room denied (member and leader)", async () => {
    await assertInsertDenied(memberA, "chat_messages", msg({ chat_room_id: F.R2 }));
    await assertInsertDenied(leaderA, "chat_messages", msg({ chat_room_id: F.R2, user_id: U.leaderA }));
  });

  it("5. INSERT impersonation and cross-group church_group_id denied", async () => {
    await assertInsertDenied(memberA, "chat_messages", msg({ user_id: U.memberA2 }));
    await assertInsertDenied(memberA, "chat_messages", msg({ church_group_id: IDS.churches.B }));
  });

  it("6. content CHECK: 2000 chars allowed, 2001 errors (also via service client)", async () => {
    const { error: okErr } = await memberA.from("chat_messages").insert(msg({ content: "x".repeat(2000) }));
    expect(okErr).toBeNull();
    const { error: tooLong } = await memberA.from("chat_messages").insert(msg({ content: "x".repeat(2001) }));
    expect(tooLong).not.toBeNull();
    const { error: svcTooLong } = await svc.from("chat_messages").insert(msg({ content: "x".repeat(2001) }));
    expect(svcTooLong).not.toBeNull();
  });

  it("7. kind / metadata: devotion allowed, bogus errors, defaults are text / null", async () => {
    const { error: devErr } = await memberA
      .from("chat_messages")
      .insert(msg({ kind: "devotion", metadata: { ref: "x" } }));
    expect(devErr).toBeNull();

    const { error: bogusErr } = await memberA.from("chat_messages").insert(msg({ kind: "bogus" }));
    expect(bogusErr).not.toBeNull();

    const id = `${P}000000000031`;
    const { error: defErr } = await memberA.from("chat_messages").insert(msg({ id }));
    expect(defErr).toBeNull();
    const { data } = await svc.from("chat_messages").select("kind, metadata").eq("id", id).single();
    expect(data?.kind).toBe("text");
    expect(data?.metadata).toBeNull();
  });

  it("8. UPDATE: author soft-delete works; guest, leader and archived-room updates are no-ops", async () => {
    await assertUpdateNoOp(guestA, svc, "chat_messages", F.M1, { is_deleted: true });
    await assertUpdateNoOp(leaderA, svc, "chat_messages", F.M1, { is_deleted: true });
    await assertUpdateNoOp(memberA, svc, "chat_messages", F.M2, { is_deleted: true });

    await memberA.from("chat_messages").update({ is_deleted: true }).eq("id", F.M1);
    const { data } = await svc.from("chat_messages").select("is_deleted").eq("id", F.M1).single();
    expect(data?.is_deleted).toBe(true);
  });

  it("9. DELETE message is a no-op for its author", async () => {
    await assertDeleteNoOp(memberA, svc, "chat_messages", F.M1);
  });

  it("10. rooms: only leaders/admins insert; members cannot update; nobody deletes", async () => {
    await assertInsertDenied(memberA, "chat_rooms", { church_group_id: A, service_week_id: F.W4 });

    const { error: leaderErr } = await leaderA
      .from("chat_rooms")
      .insert({ church_group_id: A, service_week_id: F.W3 });
    expect(leaderErr).toBeNull();

    await assertInsertDenied(leaderA, "chat_rooms", {
      church_group_id: A,
      service_week_id: IDS.serviceWeeks.B1,
    });

    const { error: dupErr } = await svc
      .from("chat_rooms")
      .insert({ church_group_id: A, service_week_id: F.W1 });
    expect(dupErr).not.toBeNull();

    await assertUpdateNoOp(memberA, svc, "chat_rooms", F.R1, { is_archived: true });
    await assertDeleteNoOp(adminA, svc, "chat_rooms", F.R1);
  });

  it("11. pin: same-room message accepted, other room's message rejected", async () => {
    const { error } = await leaderA.from("chat_rooms").update({ pinned_message_id: F.M1 }).eq("id", F.R1);
    expect(error).toBeNull();
    const { data: pinned } = await svc.from("chat_rooms").select("pinned_message_id").eq("id", F.R1).single();
    expect(pinned?.pinned_message_id).toBe(F.M1);

    await leaderA.from("chat_rooms").update({ pinned_message_id: F.M2 }).eq("id", F.R1);
    const { data: after } = await svc.from("chat_rooms").select("pinned_message_id").eq("id", F.R1).single();
    expect(after?.pinned_message_id).toBe(F.M1);
  });

  it("12. mentions: author may mention same-group users only; others denied", async () => {
    const { error } = await memberA
      .from("chat_mentions")
      .insert({ message_id: F.M5, mentioned_user_id: U.memberA2 });
    expect(error).toBeNull();

    await assertInsertDenied(memberA, "chat_mentions", { message_id: F.M5, mentioned_user_id: U.memberB });
    await assertInsertDenied(guestA, "chat_mentions", { message_id: F.M1, mentioned_user_id: U.memberA2 });
    await assertInsertDenied(memberA, "chat_mentions", { message_id: F.M5, mentioned_user_id: U.memberA2 });
    await assertInsertDenied(memberA, "chat_mentions", { message_id: F.M2, mentioned_user_id: U.memberA2 });

    // Pending invitee cannot read mentions of M1's room.
    await svc.from("chat_mentions").insert({ message_id: F.M1, mentioned_user_id: U.adminA });
    const { data } = await memberA2.from("chat_mentions").select("id").eq("message_id", F.M1);
    expect(data ?? []).toHaveLength(0);
  });

  it("13. is_chat_room_member rpc returns true / false / false (never null)", async () => {
    const yes = await memberA.rpc("is_chat_room_member", { p_chat_room_id: F.R1 });
    expect(yes.error).toBeNull();
    expect(yes.data).toBe(true);

    const no = await memberA2.rpc("is_chat_room_member", { p_chat_room_id: F.R1 });
    expect(no.data).toBe(false);

    const missing = await memberA.rpc("is_chat_room_member", {
      p_chat_room_id: "00000000-0000-4000-8016-0000000000ff",
    });
    expect(missing.data).toBe(false);
  });

  it("14. cascade: deleting a week removes room, pinned message and mentions", async () => {
    await svc.from("chat_rooms").update({ pinned_message_id: F.M5 }).eq("id", F.R5);
    await svc.from("chat_mentions").upsert(
      { message_id: F.M5, mentioned_user_id: U.memberA2 },
      { onConflict: "message_id,mentioned_user_id" },
    );

    const { error } = await svc.from("service_weeks").delete().eq("id", F.W5);
    expect(error).toBeNull();

    const { data: rooms } = await svc.from("chat_rooms").select("id").eq("id", F.R5);
    const { data: msgs } = await svc.from("chat_messages").select("id").eq("id", F.M5);
    const { data: ments } = await svc.from("chat_mentions").select("id").eq("message_id", F.M5);
    expect(rooms).toHaveLength(0);
    expect(msgs).toHaveLength(0);
    expect(ments).toHaveLength(0);
  });
});
