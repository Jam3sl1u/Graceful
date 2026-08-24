/** @jest-environment jsdom */
// Tests for the Member Week View screen (#65):
// app/(app)/member-week/[id]/member-week-view.tsx. Mirrors
// tests/unit/app/week-view.test.tsx: `fetch` is mocked directly and keyed by
// URL (this screen issues a single fetch, but we key it anyway for clarity
// and future-proofing).

import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import MemberWeekView from "@/app/(app)/member-week/[id]/member-week-view";

const SERVICE_WEEK_ID = "22222222-2222-4222-8222-222222222222";
const URL = `/api/service-weeks/${SERVICE_WEEK_ID}/member-view`;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const baseServiceWeek = {
  id: SERVICE_WEEK_ID,
  serviceDate: "2026-07-19",
  title: "Sunday Service",
  isCancelled: false,
};

const baseData = {
  serviceWeek: baseServiceWeek,
  confirmationStatus: "accepted",
  setlist: {
    status: "published",
    songs: [
      { songId: "song-1", title: "Song One", artist: "Artist One", position: 1, effectiveKey: "D" },
      { songId: "song-2", title: "Song Two", artist: null, position: 2, effectiveKey: null },
    ],
  },
  events: [
    {
      id: "event-1",
      type: "rehearsal",
      name: "Rehearsal",
      location: "123 Main St",
      startTime: "2026-07-18T18:00:00Z",
      endTime: "2026-07-18T19:00:00Z",
      notes: "Bring a pencil",
      assigned: true,
    },
    {
      id: "event-2",
      type: "service",
      name: "Sunday Gathering",
      location: null,
      startTime: "2026-07-19T09:00:00Z",
      endTime: "2026-07-19T10:30:00Z",
      notes: null,
      assigned: false,
    },
  ],
  team: [
    { userId: "user-1", name: "Amy Other", vocalCapability: "lead", instruments: [{ id: "i1", name: "Guitar" }] },
    { userId: "user-2", name: "Zoe Caller", vocalCapability: "none", instruments: [] },
  ],
  documents: [
    {
      songId: "song-1",
      songTitle: "Song One",
      files: [
        { id: "doc-1", name: "Chart.pdf", fileType: "application/pdf", fileSizeBytes: 1024, downloadUrl: "https://r2.example/chart" },
      ],
    },
  ],
};

function mockFetch(response: Response) {
  return jest.fn((url: string) => {
    if (url === URL) return Promise.resolve(response);
    return Promise.resolve(jsonResponse(404, { error: "not mocked", code: "NOT_FOUND" }));
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("MemberWeekView", () => {
  it("shows a loading state before the fetch resolves", () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("happy path: renders header, setlist, assigned-only events, team, and documents", async () => {
    global.fetch = mockFetch(jsonResponse(200, { data: baseData })) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

    // Header / confirmation badge
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.queryByText("Cancelled")).not.toBeInTheDocument();

    // Setlist: two songs, with key placeholder for the null-key song. "Song
    // One" also appears as a Documents heading below, so scope to the list.
    const setlist = screen.getByText("Setlist").closest("section") as HTMLElement;
    expect(within(setlist).getByText(/Song One/)).toBeInTheDocument();
    expect(within(setlist).getByText(/Song Two/)).toBeInTheDocument();
    expect(within(setlist).getByText("D")).toBeInTheDocument();
    expect(within(setlist).getByText("—")).toBeInTheDocument();

    // Events: only the assigned one shows (Rehearsal), not the unassigned one
    expect(screen.getByText("Rehearsal")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sunday Gathering/ })).not.toBeInTheDocument();

    // Team: both members, including the one not assigned to any event the caller sees
    expect(screen.getByText("Amy Other")).toBeInTheDocument();
    expect(screen.getByText("Zoe Caller")).toBeInTheDocument();
    expect(screen.getByText("Guitar")).toBeInTheDocument();

    // Documents
    expect(screen.getByText("Chart.pdf")).toBeInTheDocument();
    expect(screen.getByText("Chart.pdf").closest("a")).toHaveAttribute(
      "href",
      "https://r2.example/chart",
    );

    // Floating chat button present but inert
    const chatButton = screen.getByRole("button", { name: /week chat \(coming soon\)/i });
    expect(chatButton).toBeDisabled();
  });

  it("clicking an assigned event opens the detail panel with a Maps link when location is present", async () => {
    global.fetch = mockFetch(jsonResponse(200, { data: baseData })) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Rehearsal/ }));

    expect(screen.getByText("Bring a pencil")).toBeInTheDocument();
    const mapsLink = screen.getByRole("link", { name: /open in maps/i });
    expect(mapsLink).toHaveAttribute(
      "href",
      "https://www.google.com/maps/search/?api=1&query=123%20Main%20St",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Bring a pencil")).not.toBeInTheDocument();
  });

  it("event with a null location renders the detail panel with no Maps link", async () => {
    const dataWithAssignedNoLocation = {
      ...baseData,
      events: [{ ...baseData.events[1], assigned: true }],
    };
    global.fetch = mockFetch(
      jsonResponse(200, { data: dataWithAssignedNoLocation }),
    ) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Sunday Gathering/ }));

    expect(screen.queryByRole("link", { name: /open in maps/i })).not.toBeInTheDocument();
  });

  it("published setlist with zero songs shows the distinct 'no songs' message, not 'not yet released'", async () => {
    global.fetch = mockFetch(
      jsonResponse(200, { data: { ...baseData, setlist: { status: "published", songs: [] } } }),
    ) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());
    expect(screen.getByText("No songs added yet")).toBeInTheDocument();
    expect(screen.queryByText("Setlist not yet released")).not.toBeInTheDocument();
  });

  it("no/draft setlist shows 'not yet released'", async () => {
    global.fetch = mockFetch(
      jsonResponse(200, { data: { ...baseData, setlist: null } }),
    ) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());
    expect(screen.getByText("Setlist not yet released")).toBeInTheDocument();
  });

  it("no assigned events shows the empty-events message", async () => {
    global.fetch = mockFetch(
      jsonResponse(200, {
        data: { ...baseData, events: baseData.events.map((e) => ({ ...e, assigned: false })) },
      }),
    ) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());
    expect(screen.getByText("You're not assigned to any events this week")).toBeInTheDocument();
  });

  it("empty team shows the empty-team message", async () => {
    global.fetch = mockFetch(
      jsonResponse(200, { data: { ...baseData, team: [] } }),
    ) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());
    expect(screen.getByText("No confirmed team yet")).toBeInTheDocument();
  });

  it("empty documents shows the empty-documents message", async () => {
    global.fetch = mockFetch(
      jsonResponse(200, { data: { ...baseData, documents: [] } }),
    ) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());
    expect(screen.getByText("No documents for this week's songs")).toBeInTheDocument();
  });

  it("no invitation (confirmationStatus null) shows the 'Not invited' badge and still renders the screen", async () => {
    global.fetch = mockFetch(
      jsonResponse(200, { data: { ...baseData, confirmationStatus: null } }),
    ) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());
    expect(screen.getByText("Not invited")).toBeInTheDocument();
  });

  it("cancelled week shows a Cancelled badge", async () => {
    global.fetch = mockFetch(
      jsonResponse(200, {
        data: { ...baseData, serviceWeek: { ...baseServiceWeek, isCancelled: true } },
      }),
    ) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("a 404 shows the not-found view", async () => {
    global.fetch = mockFetch(
      jsonResponse(404, { error: "Not found", code: "NOT_FOUND" }),
    ) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText(/not found/i)).toBeInTheDocument());
  });

  it("a 403 shows the forbidden view", async () => {
    global.fetch = mockFetch(
      jsonResponse(403, { error: "Insufficient permissions", code: "FORBIDDEN" }),
    ) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText(/don.t have access/i)).toBeInTheDocument());
  });

  it("failure case: a network error shows the error view", async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument());
  });

  it("an unexpected 500 shows the generic error view", async () => {
    global.fetch = mockFetch(
      jsonResponse(500, { error: "Internal error", code: "INTERNAL" }),
    ) as unknown as typeof fetch;
    render(<MemberWeekView serviceWeekId={SERVICE_WEEK_ID} />);

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument());
  });
});
