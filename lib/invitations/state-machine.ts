import type { InvitationStatus } from "@/types/domain";

// The pure, DB-free, canonical declaration of the invitation state machine.
// This module does not call the DB or any handler — it exists as an
// isolated, exhaustively-testable spec of legal invitation transitions.
// `app/api/invitations/handler.ts` uses canTransition/applyTransition/
// canInvite for its deny, withdraw, and BR-08 cap logic. The `accept`
// transition and its validation are owned by the `accept_invitation`
// Postgres SECURITY DEFINER RPC (SQL, unreachable from this module) and are
// intentionally not wired here — see supabase/migrations for that logic.

export type InvitationAction = "accept" | "deny" | "withdraw" | "expire";

// BR-08 (PRD §8): a member who has denied this many invitations for a given
// service week cannot be re-invited for it.
export const MAX_DENIALS_PER_WEEK = 3;

export class InvalidInvitationTransitionError extends Error {
  readonly from: InvitationStatus;
  readonly action: InvitationAction;

  constructor(from: InvitationStatus, action: InvitationAction) {
    super(`Invalid invitation transition: cannot "${action}" from "${from}"`);
    this.name = "InvalidInvitationTransitionError";
    this.from = from;
    this.action = action;
  }
}

export class DenialCapReachedError extends Error {
  readonly priorDenialCount: number;

  constructor(priorDenialCount: number) {
    super(
      `Denial cap reached: ${priorDenialCount} prior denials for this week (cap is ${MAX_DENIALS_PER_WEEK})`,
    );
    this.name = "DenialCapReachedError";
    this.priorDenialCount = priorDenialCount;
  }
}

// The single source of truth for legal transitions. Only "pending" has any
// legal outgoing action; every other status is terminal.
const TRANSITIONS: Record<InvitationStatus, Partial<Record<InvitationAction, InvitationStatus>>> = {
  pending: {
    accept: "accepted",
    deny: "denied",
    withdraw: "withdrawn",
    expire: "expired",
  },
  accepted: {},
  denied: {},
  withdrawn: {},
  expired: {},
};

// True iff `action` is legal from status `from`.
export function canTransition(from: InvitationStatus, action: InvitationAction): boolean {
  return TRANSITIONS[from]?.[action] !== undefined;
}

// Returns the resulting status for a legal transition; THROWS
// InvalidInvitationTransitionError for any illegal one. Must never silently
// return the unchanged status.
export function applyTransition(from: InvitationStatus, action: InvitationAction): InvitationStatus {
  const result = TRANSITIONS[from]?.[action];
  if (result === undefined) {
    throw new InvalidInvitationTransitionError(from, action);
  }
  return result;
}

// BR-08 gate. True iff a member with `priorDenialCount` prior denials for a
// week may still be invited again for that week.
export function canInvite(priorDenialCount: number): boolean {
  return priorDenialCount < MAX_DENIALS_PER_WEEK;
}

// BR-08 gate, throwing variant; THROWS DenialCapReachedError when the cap is hit.
export function assertCanInvite(priorDenialCount: number): void {
  if (!canInvite(priorDenialCount)) {
    throw new DenialCapReachedError(priorDenialCount);
  }
}
