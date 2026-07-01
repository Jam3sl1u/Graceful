import "server-only";

// TODO(Sprint 2 #36): durable scheduling client (QSTASH_TOKEN /
// QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY) backing the 24-hour
// dual-party invitation reminder loop.
export async function scheduleReminder(_invitationId: string, _fireAt: Date): Promise<void> {
  throw new Error("scheduleReminder not implemented — see Sprint 2 #36");
}

export async function cancelReminder(_invitationId: string): Promise<void> {
  throw new Error("cancelReminder not implemented — see Sprint 2 #36");
}
