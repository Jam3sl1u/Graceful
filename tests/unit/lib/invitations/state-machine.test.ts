import {
  applyTransition,
  assertCanInvite,
  canInvite,
  canTransition,
  DenialCapReachedError,
  InvalidInvitationTransitionError,
  MAX_DENIALS_PER_WEEK,
  type InvitationAction,
} from "@/lib/invitations/state-machine";
import type { InvitationStatus } from "@/types/domain";

const ALL_STATUSES: InvitationStatus[] = ["pending", "accepted", "denied", "withdrawn", "expired"];
const ALL_ACTIONS: InvitationAction[] = ["accept", "deny", "withdraw", "expire"];

describe("invitation state machine — valid transitions", () => {
  it("pending -> accepted via accept", () => {
    expect(applyTransition("pending", "accept")).toBe("accepted");
    expect(canTransition("pending", "accept")).toBe(true);
  });

  it("pending -> denied via deny", () => {
    expect(applyTransition("pending", "deny")).toBe("denied");
    expect(canTransition("pending", "deny")).toBe(true);
  });

  it("pending -> withdrawn via withdraw", () => {
    expect(applyTransition("pending", "withdraw")).toBe("withdrawn");
    expect(canTransition("pending", "withdraw")).toBe(true);
  });

  it("pending -> expired via expire", () => {
    expect(applyTransition("pending", "expire")).toBe("expired");
    expect(canTransition("pending", "expire")).toBe(true);
  });
});

describe("invitation state machine — invalid transitions", () => {
  it("accepted -> accepted via accept throws", () => {
    expect(() => applyTransition("accepted", "accept")).toThrow(InvalidInvitationTransitionError);
    expect(canTransition("accepted", "accept")).toBe(false);
  });

  it("denied -> accepted via accept throws", () => {
    expect(() => applyTransition("denied", "accept")).toThrow(InvalidInvitationTransitionError);
    expect(canTransition("denied", "accept")).toBe(false);
  });

  it("withdrawn -> accepted via accept throws", () => {
    expect(() => applyTransition("withdrawn", "accept")).toThrow(InvalidInvitationTransitionError);
    expect(canTransition("withdrawn", "accept")).toBe(false);
  });

  it("accepted -> denied via deny throws (terminal source, other action)", () => {
    expect(() => applyTransition("accepted", "deny")).toThrow(InvalidInvitationTransitionError);
    expect(canTransition("accepted", "deny")).toBe(false);
  });

  it("accepted -> withdrawn via withdraw throws (terminal source, other action)", () => {
    expect(() => applyTransition("accepted", "withdraw")).toThrow(InvalidInvitationTransitionError);
    expect(canTransition("accepted", "withdraw")).toBe(false);
  });

  it("denied -> denied via deny throws (re-applying the action that reached it)", () => {
    expect(() => applyTransition("denied", "deny")).toThrow(InvalidInvitationTransitionError);
    expect(canTransition("denied", "deny")).toBe(false);
  });

  it("withdrawn -> withdrawn via withdraw throws (re-applying the action that reached it)", () => {
    expect(() => applyTransition("withdrawn", "withdraw")).toThrow(InvalidInvitationTransitionError);
    expect(canTransition("withdrawn", "withdraw")).toBe(false);
  });

  it("expired -> accepted via accept throws", () => {
    expect(() => applyTransition("expired", "accept")).toThrow(InvalidInvitationTransitionError);
    expect(canTransition("expired", "accept")).toBe(false);
  });

  it("throws with the correct .from and .action, proving it fails loudly with context", () => {
    try {
      applyTransition("accepted", "withdraw");
      throw new Error("expected applyTransition to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidInvitationTransitionError);
      const typed = err as InvalidInvitationTransitionError;
      expect(typed.name).toBe("InvalidInvitationTransitionError");
      expect(typed.from).toBe("accepted");
      expect(typed.action).toBe("withdraw");
    }
  });

  it("guards against a runtime-unknown action", () => {
    const bogusAction = "bogus" as InvitationAction;
    expect(() => applyTransition("pending", bogusAction)).toThrow(InvalidInvitationTransitionError);
    expect(canTransition("pending", bogusAction)).toBe(false);
  });

  it("exhaustively covers every (status, action) pair: only the 4 pending -> * pairs are legal", () => {
    const legalPairs = new Set(
      ALL_ACTIONS.map((action) => `pending:${action}`),
    );

    for (const status of ALL_STATUSES) {
      for (const action of ALL_ACTIONS) {
        const key = `${status}:${action}`;
        if (legalPairs.has(key)) {
          expect(canTransition(status, action)).toBe(true);
          expect(() => applyTransition(status, action)).not.toThrow();
        } else {
          expect(canTransition(status, action)).toBe(false);
          expect(() => applyTransition(status, action)).toThrow(InvalidInvitationTransitionError);
        }
      }
    }
  });
});

describe("invitation state machine — BR-08 denial cap", () => {
  it("allows invites below the cap", () => {
    expect(canInvite(0)).toBe(true);
    expect(canInvite(1)).toBe(true);
    expect(canInvite(2)).toBe(true);
  });

  it("blocks invites once the cap is reached (at exactly MAX_DENIALS_PER_WEEK)", () => {
    expect(canInvite(MAX_DENIALS_PER_WEEK)).toBe(false);
  });

  it("blocks invites above the cap", () => {
    expect(canInvite(MAX_DENIALS_PER_WEEK + 1)).toBe(false);
  });

  it("MAX_DENIALS_PER_WEEK is 3", () => {
    expect(MAX_DENIALS_PER_WEEK).toBe(3);
  });

  it("assertCanInvite does not throw below the cap", () => {
    expect(() => assertCanInvite(MAX_DENIALS_PER_WEEK - 1)).not.toThrow();
  });

  it("assertCanInvite throws DenialCapReachedError at and above the cap, exposing priorDenialCount", () => {
    expect(() => assertCanInvite(MAX_DENIALS_PER_WEEK)).toThrow(DenialCapReachedError);
    expect(() => assertCanInvite(MAX_DENIALS_PER_WEEK + 1)).toThrow(DenialCapReachedError);

    try {
      assertCanInvite(MAX_DENIALS_PER_WEEK);
      throw new Error("expected assertCanInvite to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DenialCapReachedError);
      const typed = err as DenialCapReachedError;
      expect(typed.name).toBe("DenialCapReachedError");
      expect(typed.priorDenialCount).toBe(MAX_DENIALS_PER_WEEK);
    }
  });
});
