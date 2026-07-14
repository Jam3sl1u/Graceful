import "server-only";

// TODO(Sprint 3 #62): create/update/delete Google Calendar events using a
// member's decrypted OAuth token. Graceful degradation + re-auth prompt on a
// revoked token, per PRD §19.2.
export async function createEvent(_encryptedToken: string, _event: unknown): Promise<void> {
  throw new Error("createEvent not implemented — see Sprint 3 #62");
}

export async function updateEvent(_encryptedToken: string, _event: unknown): Promise<void> {
  throw new Error("updateEvent not implemented — see Sprint 3 #62");
}

export async function deleteEvent(_encryptedToken: string, _eventId: string): Promise<void> {
  throw new Error("deleteEvent not implemented — see Sprint 3 #62");
}
