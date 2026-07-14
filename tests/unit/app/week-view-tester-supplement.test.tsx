/** @jest-environment jsdom */
// Supplementary tests written independently by the Tester stage for #48
// (Week View screen, app/(app)/week/[id]/week-view.tsx).
//
// The coder's own week-view.test.tsx covers the happy path, all five roster
// statuses (including conflict-overrides-accepted), nav-arrow wiring,
// cancelled-week badge, sidebar collapse, one core-fetch 403, the 404
// not-found view, graceful degradation, empty roster, and a network-error
// failure case very thoroughly. It leaves a few gaps this file closes:
//   1. The spec's "no invitation, or only withdrawn/expired" Open case is
//      only exercised via a member entirely ABSENT from the invitations
//      list. A member whose only (or most recent) invitation is `withdrawn`
//      is never tried — a regression that mapped `withdrawn` to some other
//      status (or crashed) would slip past the existing suite.
//   2. The "disabled nav arrow" behavior is only exercised via a *failed*
//      week-list fetch (both arrows degrade to disabled together). The
//      genuine, spec-named "no neighbor exists" case — being at the very
//      first or last week in an otherwise-successful list — is never
//      independently tried, so a regression that only disabled arrows on
//      fetch failure (but mishandled genuine edge-of-list index math, e.g.
//      an off-by-one in getNeighborWeekIds) would not be caught.
//   3. 403 is only exercised via the church-group/members fetch. The spec
//      lists /api/invitations and /api/conflicts as equally core,
//      forbidden-gated fetches; this file tries both independently so a
//      regression that only checked membersRes.status for 403 (forgetting
//      invitationsRes/conflictsRes) would be caught.

import { render, screen, waitFor, within } from "@testing-library/react";
import WeekView from "@/app/(app)/week/[id]/week-view";

const SERVICE_WEEK_ID = "22222222-2222-2222-2222-222222222222";
const FIRST_WEEK_ID = "55555555-5555-5555-5555-555555555555";
const LAST_WEEK_ID = "66666666-6666-6666-6666-666666666666";

const MEMBER_WITHDRAWN = "ffffffff-ffff-ffff-ffff-ffffffffffff";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const serviceWeek = {
  id: SERVICE_WEEK_ID,
  serviceDate: "2026-07-19",
  title: "Sunday Service",
  isCancelled: false,
};

const members = [{ id: MEMBER_WITHDRAWN, name: "Withdrawn Member" }];

function mockFetchByUrl(overrides: Record<string, Response> = {}) {
  const defaults: Record<string, Response> = {
    [`/api/service-weeks/${SERVICE_WEEK_ID}`]: jsonResponse(200, { data: { serviceWeek } }),
    [`/api/service-weeks`]: jsonResponse(200, {
      data: {
        serviceWeeks: [
          { ...serviceWeek, id: FIRST_WEEK_ID, serviceDate: "2026-07-26" },
          { ...serviceWeek, id: SERVICE_WEEK_ID, serviceDate: "2026-07-19" },
          { ...serviceWeek, id: LAST_WEEK_ID, serviceDate: "2026-07-12" },
        ],
      },
    }),
    [`/api/church-group/members`]: jsonResponse(200, { data: { members } }),
    [`/api/invitations?serviceWeekId=${SERVICE_WEEK_ID}`]: jsonResponse(200, { data: { invitations: [] } }),
    [`/api/conflicts`]: jsonResponse(200, { data: { conflicts: [] } }),
  };
  const responses = { ...defaults, ...overrides };

  return jest.fn((url: string) => {
    if (url.startsWith("/api/availability/team")) {
      return Promise.resolve(
        responses["/api/availability/team"] ?? jsonResponse(200, { data: { members: [] } }),
      );
    }
    const match = responses[url];
    if (match) return Promise.resolve(match);
    return Promise.resolve(jsonResponse(404, { error: "not mocked", code: "NOT_FOUND" }));
  });
}

beforeEach(() => {
  global.fetch = mockFetchByUrl() as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("WeekView — tester supplement (#48)", () => {
  it("a member whose only invitation is withdrawn reads as Open with + Invite, not crashed/mislabeled", async () => {
    global.fetch = mockFetchByUrl({
      [`/api/invitations?serviceWeekId=${SERVICE_WEEK_ID}`]: jsonResponse(200, {
        data: {
          invitations: [
            {
              id: "inv-withdrawn",
              serviceWeekId: SERVICE_WEEK_ID,
              userId: MEMBER_WITHDRAWN,
              roleNote: null,
              status: "withdrawn",
              responseDeadline: null,
              createdAt: "2026-07-10T00:00:00Z",
            },
          ],
        },
      }),
    }) as unknown as typeof fetch;

    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

    const slot = screen.getByText("Withdrawn Member").closest("div") as HTMLElement;
    expect(slot).not.toBeNull();
    expect(within(slot).getByText("Open")).toBeInTheDocument();
    expect(within(slot).getByRole("button", { name: /\+ invite/i })).toBeInTheDocument();
  });

  it("genuinely has no next-week neighbor when the current week is the newest in an otherwise-successful list (not merely a degraded fetch)", async () => {
    global.fetch = mockFetchByUrl({
      // The current week (SERVICE_WEEK_ID) is placed FIRST (newest) here —
      // the list fetch itself succeeds (unlike the coder's degraded-fetch
      // test), so "next" is genuinely absent by index, not by fetch failure.
      [`/api/service-weeks`]: jsonResponse(200, {
        data: {
          serviceWeeks: [
            { ...serviceWeek, id: SERVICE_WEEK_ID, serviceDate: "2026-07-19" },
            { ...serviceWeek, id: LAST_WEEK_ID, serviceDate: "2026-07-12" },
          ],
        },
      }),
    }) as unknown as typeof fetch;

    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

    // "prev" must still resolve normally to the one remaining neighbor.
    expect(screen.queryByLabelText(/next week/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/previous week/i)).toHaveAttribute("href", `/week/${LAST_WEEK_ID}`);
  });

  it("a 403 on the invitations fetch (not just church-group/members) shows the forbidden view", async () => {
    global.fetch = mockFetchByUrl({
      [`/api/invitations?serviceWeekId=${SERVICE_WEEK_ID}`]: jsonResponse(403, {
        error: "Insufficient permissions",
        code: "FORBIDDEN",
      }),
    }) as unknown as typeof fetch;

    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
    await waitFor(() => expect(screen.getByText(/don.t have access/i)).toBeInTheDocument());
    expect(screen.queryByText("Sunday Service")).not.toBeInTheDocument();
  });

  it("a 403 on the conflicts fetch (not just church-group/members) shows the forbidden view", async () => {
    global.fetch = mockFetchByUrl({
      "/api/conflicts": jsonResponse(403, { error: "Insufficient permissions", code: "FORBIDDEN" }),
    }) as unknown as typeof fetch;

    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
    await waitFor(() => expect(screen.getByText(/don.t have access/i)).toBeInTheDocument());
    expect(screen.queryByText("Sunday Service")).not.toBeInTheDocument();
  });
});
