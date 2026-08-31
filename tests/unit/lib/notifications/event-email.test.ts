// Coder-stage coverage for #69 OQ2 — lib/notifications/event-email.ts: the
// Google Calendar event email (Email to confirmed members, no SMS). Fired only
// on a material change or attendee assignment; that gating lives in the event
// handlers, this file covers the module's own recipient resolution + payload.

jest.mock("@/lib/notifications/dispatch", () => ({
  dispatchNotification: jest.fn().mockResolvedValue({
    smsSent: 0,
    smsSkipped: 0,
    smsFailed: 0,
    emailSent: 1,
    emailSkipped: 0,
    emailFailed: 0,
  }),
  appNotificationUrl: (path: string) => `https://app.test${path}`,
}));

import { dispatchNotification } from "@/lib/notifications/dispatch";
import { formatEventWhen, dispatchGoogleCalendarEventEmail } from "@/lib/notifications/event-email";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

const mockDispatch = dispatchNotification as unknown as jest.Mock;

type QueryResult = { data: unknown; error: unknown };

function chain(result: QueryResult) {
  const c: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => c),
    in: jest.fn(() => c),
    select: jest.fn(() => c),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (res: (v: QueryResult) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return c;
}

function makeSupabase(queues: Record<string, QueryResult[]>) {
  const counts: Record<string, number> = {};
  const next = (t: string) => {
    const q = queues[t] ?? [];
    const i = counts[t] ?? 0;
    counts[t] = i + 1;
    return q[i] ?? q[q.length - 1] ?? { data: null, error: null };
  };
  return {
    from: jest.fn((t: string) => ({ select: jest.fn(() => chain(next(t))) })),
  } as unknown as SupabaseClient<Database>;
}

const contact = (id: string) => ({
  id,
  name: `Member ${id}`,
  email: `${id}@example.com`,
  phone: "+15550001111",
  sms_opted_in: true,
});
const event = { name: "Saturday Rehearsal", location: "Main Hall", startTime: "2026-08-01T18:00:00.000Z" };

beforeEach(() => mockDispatch.mockClear());

describe("formatEventWhen", () => {
  it("returns UTC-anchored day/date and time strings", () => {
    const { dayDate, time } = formatEventWhen("2026-08-01T18:00:00.000Z");
    expect(dayDate).toContain("2026");
    expect(dayDate).toMatch(/Aug/);
    expect(time).toMatch(/\d/);
  });

  it("degrades gracefully on an unparseable value", () => {
    expect(formatEventWhen("not-a-date")).toEqual({ dayDate: "not-a-date", time: "" });
  });
});

describe("dispatchGoogleCalendarEventEmail", () => {
  it("emails every confirmed member of the week when no explicit recipients are given", async () => {
    const supabase = makeSupabase({
      invitations: [{ data: [{ user_id: "m1" }, { user_id: "m1" }, { user_id: "m2" }], error: null }],
      users: [{ data: [contact("m1"), contact("m2")], error: null }],
    });

    await dispatchGoogleCalendarEventEmail(supabase, {
      churchGroupId: "group-1",
      serviceWeekId: "week-1",
      event,
    });

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0];
    expect(arg.sms).toBeUndefined(); // Email + GCal only — never SMS
    expect(arg.email.template).toBe("google_calendar_event");
    expect(arg.email.data.eventName).toBe("Saturday Rehearsal");
    expect(arg.email.data.link).toBe("https://app.test/week/week-1");
    expect(arg.recipients.map((r: { userId: string }) => r.userId).sort()).toEqual(["m1", "m2"]);
  });

  it("emails only the given recipientUserIds (attendee-assignment path)", async () => {
    const supabase = makeSupabase({
      users: [{ data: [contact("m2")], error: null }],
    });

    await dispatchGoogleCalendarEventEmail(supabase, {
      churchGroupId: "group-1",
      serviceWeekId: "week-1",
      event,
      recipientUserIds: ["m2"],
    });

    const arg = mockDispatch.mock.calls[0][0];
    expect(arg.recipients).toHaveLength(1);
    expect(arg.recipients[0].userId).toBe("m2");
  });

  it("null event location falls back to 'TBD'", async () => {
    const supabase = makeSupabase({ users: [{ data: [contact("m2")], error: null }] });

    await dispatchGoogleCalendarEventEmail(supabase, {
      churchGroupId: "group-1",
      serviceWeekId: "week-1",
      event: { ...event, location: null },
      recipientUserIds: ["m2"],
    });

    expect(mockDispatch.mock.calls[0][0].email.data.location).toBe("TBD");
  });

  it("no confirmed members -> no dispatch", async () => {
    const supabase = makeSupabase({ invitations: [{ data: [], error: null }] });

    await dispatchGoogleCalendarEventEmail(supabase, {
      churchGroupId: "group-1",
      serviceWeekId: "week-1",
      event,
    });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("a query error -> silent, no dispatch, no throw", async () => {
    const supabase = makeSupabase({
      invitations: [{ data: null, error: { message: "boom" } }],
    });

    await expect(
      dispatchGoogleCalendarEventEmail(supabase, {
        churchGroupId: "group-1",
        serviceWeekId: "week-1",
        event,
      }),
    ).resolves.toBeUndefined();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("never throws even if the client throws", async () => {
    const throwing = {
      from: jest.fn(() => {
        throw new Error("boom");
      }),
    } as unknown as SupabaseClient<Database>;

    await expect(
      dispatchGoogleCalendarEventEmail(throwing, {
        churchGroupId: "group-1",
        serviceWeekId: "week-1",
        event,
        recipientUserIds: ["m2"],
      }),
    ).resolves.toBeUndefined();
  });
});
