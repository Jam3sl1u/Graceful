/** @jest-environment jsdom */
// Tests for the Invitation Response screen (#49):
// app/(public)/invite/[token]/invite-response.tsx. `fetch` is mocked
// directly (no Clerk/session involved — the whole point of this screen).

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import InviteResponse from "@/app/(public)/invite/[token]/invite-response";

const TOKEN = "a".repeat(64);
const INVITATION_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_WEEK_ID = "22222222-2222-4222-8222-222222222222";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: { get: (name: string) => headers[name] ?? null },
  } as unknown as Response;
}

function baseLookup(overrides: Record<string, unknown> = {}) {
  return {
    invitationId: INVITATION_ID,
    status: "pending",
    roleNote: "Lead vocals",
    responseDeadline: "2026-07-20T00:00:00.000Z",
    serviceWeek: {
      id: SERVICE_WEEK_ID,
      serviceDate: "2026-07-19",
      title: "Sunday Service",
    },
    events: [
      {
        id: "event-1",
        type: "rehearsal",
        name: "Rehearsal",
        location: "Main Hall",
        startTime: "2026-07-19T18:00:00.000Z",
        endTime: "2026-07-19T19:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("InviteResponse", () => {
  it("shows a loading state before the lookup resolves", () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<InviteResponse token={TOKEN} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("happy path: renders the card with role note, service date, and event details on a pending invitation", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: baseLookup() }));
    render(<InviteResponse token={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

    expect(screen.getByText(/Lead vocals/)).toBeInTheDocument();
    expect(screen.getByText("Rehearsal")).toBeInTheDocument();
    expect(screen.getByText("Main Hall")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /decline/i })).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith(`/api/invitations/respond/${TOKEN}`);
  });

  it("happy path: accepting posts responseToken and shows the accepted-success view", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: baseLookup() }))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { status: "accepted", alreadyResponded: false } }),
      );

    render(<InviteResponse token={TOKEN} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(screen.getByText(/on the schedule/i)).toBeInTheDocument());

    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/invitations/${INVITATION_ID}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ responseToken: TOKEN }),
    });
    expect(screen.getByRole("link", { name: /go to the app/i })).toHaveAttribute(
      "href",
      `/member-week/${SERVICE_WEEK_ID}`,
    );
  });

  it("decline flow: reveals a reason field + confirm, then posts to /deny and shows declined-success", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: baseLookup() }))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { status: "denied", alreadyResponded: false } }),
      );

    render(<InviteResponse token={TOKEN} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /decline/i })).toBeInTheDocument());

    // Tapping Decline must not submit immediately.
    fireEvent.click(screen.getByRole("button", { name: /decline/i }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute("maxLength", "200");
    fireEvent.change(textarea, { target: { value: "Can't make it that week" } });

    fireEvent.click(screen.getByRole("button", { name: /confirm decline/i }));

    await waitFor(() => expect(screen.getByText(/response recorded/i)).toBeInTheDocument());

    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/invitations/${INVITATION_ID}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ responseToken: TOKEN, reason: "Can't make it that week" }),
    });
    expect(screen.getByRole("link", { name: /go to the app/i })).toHaveAttribute(
      "href",
      `/member-week/${SERVICE_WEEK_ID}`,
    );
  });

  it("decline flow: 'Keep it' cancels back to the two-button state without submitting", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: baseLookup() }));
    render(<InviteResponse token={TOKEN} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /decline/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /decline/i }));
    expect(screen.getByRole("button", { name: /confirm decline/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /keep it/i }));

    expect(screen.queryByRole("button", { name: /confirm decline/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^decline$/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1); // lookup only, never submitted
  });

  it("edge case: empty events renders 'Details coming soon' without crashing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: baseLookup({ events: [] }) }));
    render(<InviteResponse token={TOKEN} />);

    await waitFor(() => expect(screen.getByText(/details coming soon/i)).toBeInTheDocument());
  });

  it("edge case: null roleNote, serviceWeek.title, and event location are omitted cleanly", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: baseLookup({
          roleNote: null,
          serviceWeek: { id: SERVICE_WEEK_ID, serviceDate: "2026-07-19", title: null },
          events: [
            {
              id: "event-1",
              type: "rehearsal",
              name: "Rehearsal",
              location: null,
              startTime: "2026-07-19T18:00:00.000Z",
              endTime: "2026-07-19T19:00:00.000Z",
            },
          ],
        }),
      }),
    );
    render(<InviteResponse token={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Rehearsal")).toBeInTheDocument());

    expect(screen.queryByText(/your role/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Sunday Service")).not.toBeInTheDocument();
    expect(screen.queryByText("Main Hall")).not.toBeInTheDocument();
  });

  it("edge case: already-responded on load shows a friendly unavailable state, never the raw status/error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: baseLookup({ status: "accepted" }) }));
    render(<InviteResponse token={TOKEN} />);

    await waitFor(() => expect(screen.getByText(/already responded/i)).toBeInTheDocument());

    expect(screen.queryByText("accepted")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /accept/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to the app/i })).toHaveAttribute(
      "href",
      `/member-week/${SERVICE_WEEK_ID}`,
    );
  });

  it("edge case: expired status from the lookup shows the unavailable view", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: baseLookup({ status: "expired" }) }));
    render(<InviteResponse token={TOKEN} />);

    await waitFor(() => expect(screen.getByText(/expired/i)).toBeInTheDocument());
  });

  it("edge case: re-tapping accept after already responding (alreadyResponded true, non-accepted status) shows unavailable", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: baseLookup() }))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { status: "denied", alreadyResponded: true } }),
      );

    render(<InviteResponse token={TOKEN} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(screen.getByText(/already responded/i)).toBeInTheDocument());
  });

  it("edge case: expired-on-submit (410 from accept) routes to the unavailable view, not a raw error", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: baseLookup() }))
      .mockResolvedValueOnce(jsonResponse(410, { error: "Invitation expired", code: "EXPIRED" }));

    render(<InviteResponse token={TOKEN} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(screen.getByText(/expired/i)).toBeInTheDocument());
    expect(screen.queryByText("EXPIRED")).not.toBeInTheDocument();
    expect(screen.queryByText("410")).not.toBeInTheDocument();
  });

  it("edge case: double-tap guard disables the buttons while an accept is in flight", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: baseLookup() }));
    let resolveAccept!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveAccept = resolve;
      }),
    );

    render(<InviteResponse token={TOKEN} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument());

    const acceptButton = screen.getByRole("button", { name: /accept/i });
    fireEvent.click(acceptButton);

    await waitFor(() => expect(acceptButton).toBeDisabled());
    expect(screen.getByRole("button", { name: /decline/i })).toBeDisabled();

    // Clicking again while in flight must not issue a second request.
    fireEvent.click(acceptButton);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveAccept(jsonResponse(200, { data: { status: "accepted", alreadyResponded: false } }));
    await waitFor(() => expect(screen.getByText(/on the schedule/i)).toBeInTheDocument());
  });

  it("failure case: a network error on the initial lookup shows the friendly unavailable view, not a crash", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    render(<InviteResponse token={TOKEN} />);

    await waitFor(() => expect(screen.getByText(/couldn.t find this invitation/i)).toBeInTheDocument());
    // No lookup ever succeeded, so no service week id is known — falls back to /dashboard.
    expect(screen.getByRole("link", { name: /go to the app/i })).toHaveAttribute("href", "/dashboard");
  });

  it("failure case: a 404 lookup shows the unavailable view (never a raw error)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { error: "Not found", code: "NOT_FOUND" }),
    );
    render(<InviteResponse token={TOKEN} />);

    await waitFor(() => expect(screen.getByText(/couldn.t find this invitation/i)).toBeInTheDocument());
    expect(screen.queryByText("NOT_FOUND")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to the app/i })).toHaveAttribute("href", "/dashboard");
  });

  it("failure case: a 429 lookup shows a rate-limited retry message, not 'not found'", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        429,
        { error: "Rate limit exceeded", code: "RATE_LIMITED" },
        { "Retry-After": "42" },
      ),
    );
    render(<InviteResponse token={TOKEN} />);

    await waitFor(() => expect(screen.getByText(/try again in 42s/i)).toBeInTheDocument());
    expect(screen.queryByText(/couldn.t find this invitation/i)).not.toBeInTheDocument();
  });

  it("failure case: a 429 on accept shows an inline retry alert and stays on the ready view", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: baseLookup() }))
      .mockResolvedValueOnce(
        jsonResponse(
          429,
          { error: "Rate limit exceeded", code: "RATE_LIMITED" },
          { "Retry-After": "7" },
        ),
      );

    render(<InviteResponse token={TOKEN} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toMatch(/try again in 7s/i);
    expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument();
  });

  it("failure case: a non-terminal error on accept (e.g. 500) shows an inline alert and stays on the ready view", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: baseLookup() }))
      .mockResolvedValueOnce(jsonResponse(500, { error: "Internal error", code: "INTERNAL" }));

    render(<InviteResponse token={TOKEN} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).not.toMatch(/INTERNAL|500/);
    // Still on the ready view: the card and both buttons remain.
    expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /decline/i })).toBeInTheDocument();
  });
});
