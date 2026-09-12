/** @jest-environment jsdom */
// Tests for the in-app Invitation Response screen (#73, PRD Screen 3 / OPEN
// QUESTION option C): app/(app)/invitations/[id]/invitation-response.tsx.
// Structurally a copy of tests/unit/app/invite-response.test.tsx, but this
// screen fetches GET /api/invitations/:id (no token in the URL) and posts to
// /accept and /deny with no `responseToken` field, since identity comes from
// the Clerk session (not a token).

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import InvitationResponse from "@/app/(app)/invitations/[id]/invitation-response";
import { UNREAD_CHANGED_EVENT } from "@/components/layout/NotificationBell";

const INVITATION_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_WEEK_ID = "22222222-2222-4222-8222-222222222222";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function baseLookup(overrides: Record<string, unknown> = {}) {
  return {
    invitationId: INVITATION_ID,
    status: "pending",
    roleNote: "Lead vocals",
    responseDeadline: "2099-07-20T00:00:00.000Z",
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

describe("InvitationResponse (in-app)", () => {
  it("shows a loading state before the lookup resolves", () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<InvitationResponse invitationId={INVITATION_ID} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("happy path: fetches by id (no token) and renders the card", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: baseLookup() }));
    render(<InvitationResponse invitationId={INVITATION_ID} />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

    expect(screen.getByText(/Lead vocals/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /decline/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`/api/invitations/${INVITATION_ID}`);
  });

  it("happy path: accepting posts an empty body (no responseToken) and shows accepted-success", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: baseLookup() }))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { status: "accepted", alreadyResponded: false } }),
      );

    render(<InvitationResponse invitationId={INVITATION_ID} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(screen.getByText(/on the schedule/i)).toBeInTheDocument());

    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/invitations/${INVITATION_ID}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(screen.getByRole("link", { name: /go to the app/i })).toHaveAttribute(
      "href",
      `/member-week/${SERVICE_WEEK_ID}`,
    );
  });

  it("accept success dispatches notifyUnreadChanged so the sidebar bell refreshes", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: baseLookup() }))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { status: "accepted", alreadyResponded: false } }),
      );

    const listener = jest.fn();
    window.addEventListener(UNREAD_CHANGED_EVENT, listener);

    render(<InvitationResponse invitationId={INVITATION_ID} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    window.removeEventListener(UNREAD_CHANGED_EVENT, listener);
  });

  it("decline flow: posts { reason } (no responseToken) and shows declined-success", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: baseLookup() }))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { status: "denied", alreadyResponded: false } }),
      );

    render(<InvitationResponse invitationId={INVITATION_ID} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /decline/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /decline/i }));
    expect(fetchMock).toHaveBeenCalledTimes(1); // decline only reveals the form, no request yet

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Can't make it that week" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm decline/i }));

    await waitFor(() => expect(screen.getByText(/response recorded/i)).toBeInTheDocument());

    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/invitations/${INVITATION_ID}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Can't make it that week" }),
    });
  });

  it("edge case: expired status from the lookup shows the unavailable view", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: baseLookup({ status: "expired" }) }));
    render(<InvitationResponse invitationId={INVITATION_ID} />);

    await waitFor(() => expect(screen.getByText(/expired/i)).toBeInTheDocument());
  });

  it("edge case: already-responded on load shows a friendly unavailable state, not the raw status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: baseLookup({ status: "accepted" }) }));
    render(<InvitationResponse invitationId={INVITATION_ID} />);

    await waitFor(() => expect(screen.getByText(/already responded/i)).toBeInTheDocument());
    expect(screen.queryByText("accepted")).not.toBeInTheDocument();
  });

  it("failure case: a 404 on the lookup shows the not-found unavailable view (mirrors the 404/no-leak contract)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: "Not found", code: "NOT_FOUND" }));
    render(<InvitationResponse invitationId={INVITATION_ID} />);

    await waitFor(() => expect(screen.getByText(/couldn.t find this invitation/i)).toBeInTheDocument());
  });

  it("failure case: a network error on the lookup shows the unavailable view, not a crash", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    render(<InvitationResponse invitationId={INVITATION_ID} />);

    await waitFor(() => expect(screen.getByText(/couldn.t find this invitation/i)).toBeInTheDocument());
  });
});
