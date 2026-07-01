import "server-only";

// TODO(Sprint 0 #5/#6): wrap @clerk/nextjs/server's auth()/currentUser(),
// and resolve the user's church_group_id + role (stored as a Clerk session
// claim so it's readable without a DB round-trip per PRD §19.1).
export async function getAuthContext(): Promise<never> {
  throw new Error("getAuthContext not implemented — see Sprint 0 #5/#6");
}
