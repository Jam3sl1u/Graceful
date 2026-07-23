/** @jest-environment jsdom */
// Tests for the Week View screen (#48):
// app/(app)/week/[id]/week-view.tsx. Mirrors
// tests/unit/app/invite-response.test.tsx: `fetch` is mocked directly, keyed
// by URL since this screen issues several concurrent fetches.

import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import WeekView from "@/app/(app)/week/[id]/week-view";

const SERVICE_WEEK_ID = "22222222-2222-2222-2222-222222222222";
const PREV_WEEK_ID = "33333333-3333-3333-3333-333333333333";
const NEXT_WEEK_ID = "44444444-4444-4444-4444-444444444444";

const MEMBER_OPEN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MEMBER_PENDING = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const MEMBER_CONFIRMED = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MEMBER_DECLINED = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const MEMBER_CONFLICT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

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

const serviceWeeksList = [
  { id: NEXT_WEEK_ID, serviceDate: "2026-07-26", title: "Next Sunday", isCancelled: false },
  { id: SERVICE_WEEK_ID, serviceDate: "2026-07-19", title: "Sunday Service", isCancelled: false },
  { id: PREV_WEEK_ID, serviceDate: "2026-07-12", title: "Prev Sunday", isCancelled: false },
];

const members = [
  { id: MEMBER_OPEN, name: "Open Member" },
  { id: MEMBER_PENDING, name: "Pending Member" },
  { id: MEMBER_CONFIRMED, name: "Confirmed Member" },
  { id: MEMBER_DECLINED, name: "Declined Member" },
  { id: MEMBER_CONFLICT, name: "Conflict Member" },
];

const invitations = [
  {
    id: "inv-pending",
    serviceWeekId: SERVICE_WEEK_ID,
    userId: MEMBER_PENDING,
    roleNote: null,
    status: "pending",
    responseDeadline: null,
    createdAt: "2026-07-12T00:00:00Z",
  },
  {
    id: "inv-confirmed",
    serviceWeekId: SERVICE_WEEK_ID,
    userId: MEMBER_CONFIRMED,
    roleNote: null,
    status: "accepted",
    responseDeadline: null,
    createdAt: "2026-07-12T00:00:00Z",
  },
  {
    id: "inv-declined",
    serviceWeekId: SERVICE_WEEK_ID,
    userId: MEMBER_DECLINED,
    roleNote: null,
    status: "denied",
    responseDeadline: null,
    createdAt: "2026-07-12T00:00:00Z",
  },
  {
    id: "inv-conflict-stale",
    serviceWeekId: SERVICE_WEEK_ID,
    userId: MEMBER_CONFLICT,
    roleNote: null,
    status: "denied",
    responseDeadline: null,
    createdAt: "2026-07-10T00:00:00Z",
  },
  {
    id: "inv-conflict-current",
    serviceWeekId: SERVICE_WEEK_ID,
    userId: MEMBER_CONFLICT,
    roleNote: null,
    status: "accepted",
    responseDeadline: null,
    createdAt: "2026-07-13T00:00:00Z",
  },
];

const conflicts = [
  {
    id: "conflict-1",
    invitationId: "inv-conflict-current",
    memberId: MEMBER_CONFLICT,
    serviceWeekId: SERVICE_WEEK_ID,
  },
];

function mockFetchByUrl(overrides: Record<string, Response> = {}) {
  const defaults: Record<string, Response> = {
    [`/api/service-weeks/${SERVICE_WEEK_ID}`]: jsonResponse(200, { data: { serviceWeek: serviceWeek } }),
    [`/api/service-weeks`]: jsonResponse(200, { data: { serviceWeeks: serviceWeeksList } }),
    [`/api/church-group/members`]: jsonResponse(200, { data: { members } }),
    [`/api/invitations?serviceWeekId=${SERVICE_WEEK_ID}`]: jsonResponse(200, { data: { invitations } }),
    [`/api/conflicts`]: jsonResponse(200, { data: { conflicts } }),
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

describe("WeekView", () => {
  it("shows a loading state before the fetches resolve", () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("happy path: loads and renders the header, roster, events, and setlist cards", async () => {
    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Events")).toBeInTheDocument();
    expect(screen.getByText("No events yet")).toBeInTheDocument();
    expect(screen.getByText("Setlist")).toBeInTheDocument();
    expect(screen.getByText("0 songs")).toBeInTheDocument();
  });

  it("roster status mapping: Open, Pending, Confirmed, Declined, and Conflict (overrides accepted)", async () => {
    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

    const openSlot = screen.getByText("Open Member").closest("div") as HTMLElement;
    expect(within(openSlot).getByText("Open")).toBeInTheDocument();
    expect(within(openSlot).getByRole("button", { name: /\+ invite/i })).toBeInTheDocument();

    const pendingSlot = screen.getByText("Pending Member").closest("div") as HTMLElement;
    expect(within(pendingSlot).getByText("Pending")).toBeInTheDocument();
    expect(within(pendingSlot).queryByRole("button", { name: /\+ invite/i })).not.toBeInTheDocument();

    const confirmedSlot = screen.getByText("Confirmed Member").closest("div") as HTMLElement;
    expect(within(confirmedSlot).getByText("Confirmed")).toBeInTheDocument();

    const declinedSlot = screen.getByText("Declined Member").closest("div") as HTMLElement;
    expect(within(declinedSlot).getByText("Declined")).toBeInTheDocument();

    // Conflict overrides accepted: the current (max-createdAt) invitation for
    // this member is accepted, but it is also flagged in conflicts, so it
    // must read "Conflict" (red), not "Confirmed".
    const conflictSlot = screen.getByText("Conflict Member").closest("div") as HTMLElement;
    expect(within(conflictSlot).getByText("Conflict")).toBeInTheDocument();
    expect(within(conflictSlot).queryByText("Confirmed")).not.toBeInTheDocument();
  });

  it("nav arrows link to the prev/next week ids computed from the service-weeks list", async () => {
    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

    expect(screen.getByLabelText(/previous week/i)).toHaveAttribute("href", `/week/${PREV_WEEK_ID}`);
    expect(screen.getByLabelText(/next week/i)).toHaveAttribute("href", `/week/${NEXT_WEEK_ID}`);
  });

  it("cancelled week shows a Cancelled danger badge instead of Draft", async () => {
    global.fetch = mockFetchByUrl({
      [`/api/service-weeks/${SERVICE_WEEK_ID}`]: jsonResponse(200, {
        data: { serviceWeek: { ...serviceWeek, isCancelled: true } },
      }),
    }) as unknown as typeof fetch;

    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
    await waitFor(() => expect(screen.getByText("Cancelled")).toBeInTheDocument());
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
  });

  it("sidebar collapse toggle hides and reveals the availability grid", async () => {
    global.fetch = mockFetchByUrl({
      "/api/availability/team": jsonResponse(200, {
        data: {
          members: [{ userId: MEMBER_PENDING, entries: [{ date: "2026-07-19", isAvailable: true, note: null }] }],
        },
      }),
    }) as unknown as typeof fetch;

    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText("Pending Member")).toHaveLength(2));

    const toggle = screen.getByRole("button", { name: /collapse availability sidebar/i });
    fireEvent.click(toggle);

    // Only the roster grid's occurrence remains — the sidebar row is gone.
    expect(screen.getAllByText("Pending Member")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /expand availability sidebar/i })).toBeInTheDocument();
  });

  it("a 403 on a core fetch (church-group/members) shows the forbidden view", async () => {
    global.fetch = mockFetchByUrl({
      "/api/church-group/members": jsonResponse(403, { error: "Insufficient permissions", code: "FORBIDDEN" }),
    }) as unknown as typeof fetch;

    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
    await waitFor(() => expect(screen.getByText(/don.t have access/i)).toBeInTheDocument());
    expect(screen.queryByText("Sunday Service")).not.toBeInTheDocument();
  });

  it("a 404 on the service-week fetch shows the not-found view", async () => {
    global.fetch = mockFetchByUrl({
      [`/api/service-weeks/${SERVICE_WEEK_ID}`]: jsonResponse(404, { error: "Not found", code: "NOT_FOUND" }),
    }) as unknown as typeof fetch;

    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeInTheDocument());
  });

  it("degrades gracefully (still ready) when the availability and week-list fetches fail", async () => {
    global.fetch = mockFetchByUrl({
      "/api/service-weeks": jsonResponse(500, { error: "Internal error", code: "INTERNAL" }),
      "/api/availability/team": jsonResponse(500, { error: "Internal error", code: "INTERNAL" }),
    }) as unknown as typeof fetch;

    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

    // Nav arrows both disabled (no neighbor data) — not links.
    expect(screen.queryByLabelText(/previous week/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/next week/i)).not.toBeInTheDocument();
    expect(screen.getByText("No availability data")).toBeInTheDocument();
  });

  it("empty roster renders an empty state instead of crashing", async () => {
    global.fetch = mockFetchByUrl({
      "/api/church-group/members": jsonResponse(200, { data: { members: [] } }),
    }) as unknown as typeof fetch;

    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());
    expect(screen.getByText("No members yet")).toBeInTheDocument();
  });

  it("failure case: a network error on the core fetches shows the error view", async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;

    render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument());
  });

  describe("+ Invite button (#40)", () => {
    const newInvitation = {
      id: "inv-new",
      serviceWeekId: SERVICE_WEEK_ID,
      userId: MEMBER_OPEN,
      roleNote: null,
      status: "pending",
      responseToken: "unused-in-week-view",
      responseDeadline: null,
      invitedBy: "someone",
      createdAt: "2026-07-19T00:00:00Z",
    };

    it("happy path: posts to /api/invitations and flips the member to Pending on success", async () => {
      const fetchMock = mockFetchByUrl({
        "/api/invitations": jsonResponse(201, { data: { invitation: newInvitation } }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
      await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

      const openSlot = screen.getByText("Open Member").closest("div") as HTMLElement;
      fireEvent.click(within(openSlot).getByRole("button", { name: /\+ invite/i }));

      await waitFor(() => expect(within(openSlot).getByText("Pending")).toBeInTheDocument());
      expect(within(openSlot).queryByRole("button", { name: /\+ invite/i })).not.toBeInTheDocument();

      expect(fetchMock).toHaveBeenCalledWith("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceWeekId: SERVICE_WEEK_ID, userId: MEMBER_OPEN }),
      });
    });

    it("BR-05 conflict: a 409 prompts for confirmation and retries with acknowledgeConflict on accept", async () => {
      const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
      const fetchMock = jest.fn((url: string, init?: RequestInit) => {
        if (url === "/api/invitations" && init?.method === "POST") {
          const body = JSON.parse(init.body as string);
          if (body.acknowledgeConflict === true) {
            return Promise.resolve(jsonResponse(201, { data: { invitation: newInvitation } }));
          }
          return Promise.resolve(
            jsonResponse(409, { error: "Member already confirmed for another week", code: "CONFLICT" }),
          );
        }
        return mockFetchByUrl()(url);
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
      await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

      const openSlot = screen.getByText("Open Member").closest("div") as HTMLElement;
      fireEvent.click(within(openSlot).getByRole("button", { name: /\+ invite/i }));

      await waitFor(() => expect(within(openSlot).getByText("Pending")).toBeInTheDocument());
      expect(confirmSpy).toHaveBeenCalled();

      confirmSpy.mockRestore();
    });

    it("BR-05 conflict: declining the confirm prompt leaves the member Open with no retry request", async () => {
      const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
      const fetchMock = jest.fn((url: string, init?: RequestInit) => {
        if (url === "/api/invitations" && init?.method === "POST") {
          return Promise.resolve(
            jsonResponse(409, { error: "Member already confirmed for another week", code: "CONFLICT" }),
          );
        }
        return mockFetchByUrl()(url);
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
      await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

      const openSlot = screen.getByText("Open Member").closest("div") as HTMLElement;
      fireEvent.click(within(openSlot).getByRole("button", { name: /\+ invite/i }));

      await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
      expect(within(openSlot).getByText("Open")).toBeInTheDocument();
      const postCalls = fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/invitations" && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(postCalls).toHaveLength(1); // declined confirm must not retry

      confirmSpy.mockRestore();
    });

    it("failure case: a non-409 error shows an inline alert and the member stays Open", async () => {
      const fetchMock = mockFetchByUrl({
        "/api/invitations": jsonResponse(500, { error: "Internal error", code: "INTERNAL" }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<WeekView serviceWeekId={SERVICE_WEEK_ID} />);
      await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

      const openSlot = screen.getByText("Open Member").closest("div") as HTMLElement;
      fireEvent.click(within(openSlot).getByRole("button", { name: /\+ invite/i }));

      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
      expect(within(openSlot).getByText("Open")).toBeInTheDocument();
    });
  });
});
