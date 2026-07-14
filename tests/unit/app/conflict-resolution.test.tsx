/** @jest-environment jsdom */
// Tests for the Conflict Resolution screen (#50):
// app/(app)/conflicts/[id]/conflict-resolution.tsx. `fetch` is mocked
// directly, mirroring tests/unit/app/invite-response.test.tsx.

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ConflictResolution from "@/app/(app)/conflicts/[id]/conflict-resolution";

const CONFLICT_ID = "44444444-4444-4444-4444-444444444444";
const OTHER_CONFLICT_ID = "55555555-5555-5555-5555-555555555555";
const SERVICE_WEEK_ID = "22222222-2222-2222-2222-222222222222";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function baseConflict(overrides: Record<string, unknown> = {}) {
  return {
    id: CONFLICT_ID,
    memberName: "Jane Doe",
    serviceDate: "2026-07-19",
    serviceWeekTitle: "Sunday Service",
    serviceWeekId: SERVICE_WEEK_ID,
    roleNote: "Lead vocals",
    triggerReason: "marked_unavailable",
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

describe("ConflictResolution", () => {
  it("shows a loading state before the lookup resolves", () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ConflictResolution conflictId={CONFLICT_ID} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("happy path: renders member name, service date, role note, reason, and the three actions", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { conflicts: [baseConflict()] } }),
    );
    render(<ConflictResolution conflictId={CONFLICT_ID} />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText(/Lead vocals/)).toBeInTheDocument();
    expect(screen.getByText(/marked_unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /find a replacement/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark as resolved/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith("/api/conflicts");
  });

  it("'Find a Replacement' anchor has the expected href with encoded roleNote and serviceWeekId", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { conflicts: [baseConflict({ roleNote: "Lead vocals" })] } }),
    );
    render(<ConflictResolution conflictId={CONFLICT_ID} />);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /find a replacement/i })).toBeInTheDocument(),
    );

    expect(screen.getByRole("link", { name: /find a replacement/i })).toHaveAttribute(
      "href",
      `/invitations/new?serviceWeekId=${SERVICE_WEEK_ID}&roleNote=${encodeURIComponent("Lead vocals")}`,
    );
  });

  it("'Mark as Resolved' posts { resolution: 'member_reconfirmed' } and shows the success view", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: { conflicts: [baseConflict()] } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { conflict: { id: CONFLICT_ID } } }));

    render(<ConflictResolution conflictId={CONFLICT_ID} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /mark as resolved/i })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /mark as resolved/i }));

    await waitFor(() => expect(screen.getByText(/conflict resolved/i)).toBeInTheDocument());

    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/conflicts/${CONFLICT_ID}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution: "member_reconfirmed" }),
    });
  });

  it("'Dismiss' posts { resolution: 'admin_dismissed' } and shows the success view", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: { conflicts: [baseConflict()] } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { conflict: { id: CONFLICT_ID } } }));

    render(<ConflictResolution conflictId={CONFLICT_ID} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    await waitFor(() => expect(screen.getByText(/conflict resolved/i)).toBeInTheDocument());

    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/conflicts/${CONFLICT_ID}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution: "admin_dismissed" }),
    });
  });

  it("edge case: null roleNote and triggerReason are omitted cleanly", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: { conflicts: [baseConflict({ roleNote: null, triggerReason: null })] },
      }),
    );
    render(<ConflictResolution conflictId={CONFLICT_ID} />);

    await waitFor(() => expect(screen.getByText("Jane Doe")).toBeInTheDocument());

    expect(screen.queryByText(/original role/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/reason/i)).not.toBeInTheDocument();
  });

  it("edge case: null serviceWeekTitle falls back to 'Service'", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { conflicts: [baseConflict({ serviceWeekTitle: null })] } }),
    );
    render(<ConflictResolution conflictId={CONFLICT_ID} />);

    await waitFor(() => expect(screen.getByText("Service")).toBeInTheDocument());
  });

  it("edge case: in-flight resolve disables all buttons and prevents double-submit", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { conflicts: [baseConflict()] } }));
    let resolveResolve!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveResolve = resolve;
      }),
    );

    render(<ConflictResolution conflictId={CONFLICT_ID} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /mark as resolved/i })).toBeInTheDocument(),
    );

    const markResolvedButton = screen.getByRole("button", { name: /mark as resolved/i });
    fireEvent.click(markResolvedButton);

    await waitFor(() => expect(markResolvedButton).toBeDisabled());
    const allButtons = screen.getAllByRole("button");
    expect(allButtons).toHaveLength(2);
    allButtons.forEach((button) => expect(button).toBeDisabled());

    // Clicking again while in flight must not issue a second request.
    fireEvent.click(markResolvedButton);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveResolve(jsonResponse(200, { data: { conflict: { id: CONFLICT_ID } } }));
    await waitFor(() => expect(screen.getByText(/conflict resolved/i)).toBeInTheDocument());
  });

  it("failure case: not-found in the open list shows the unavailable view", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { conflicts: [baseConflict({ id: OTHER_CONFLICT_ID })] } }),
    );
    render(<ConflictResolution conflictId={CONFLICT_ID} />);

    await waitFor(() =>
      expect(screen.getByText(/resolved or no longer exists/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: /back to conflicts/i })).toBeInTheDocument();
  });

  it("failure case: a network error on the initial lookup shows the unavailable view, not a crash", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    render(<ConflictResolution conflictId={CONFLICT_ID} />);

    await waitFor(() =>
      expect(screen.getByText(/resolved or no longer exists/i)).toBeInTheDocument(),
    );
  });

  it("failure case: 409 on resolve shows the unavailable view", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: { conflicts: [baseConflict()] } }))
      .mockResolvedValueOnce(jsonResponse(409, { error: "Conflict already resolved", code: "CONFLICT" }));

    render(<ConflictResolution conflictId={CONFLICT_ID} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /mark as resolved/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /mark as resolved/i }));

    await waitFor(() =>
      expect(screen.getByText(/resolved or no longer exists/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText("CONFLICT")).not.toBeInTheDocument();
    expect(screen.queryByText("409")).not.toBeInTheDocument();
  });

  it("failure case: a non-OK error on resolve shows an inline alert and stays on the ready view", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: { conflicts: [baseConflict()] } }))
      .mockResolvedValueOnce(jsonResponse(500, { error: "Internal error", code: "INTERNAL" }));

    render(<ConflictResolution conflictId={CONFLICT_ID} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /mark as resolved/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /mark as resolved/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).not.toMatch(/INTERNAL|500/);
    expect(screen.getByRole("button", { name: /mark as resolved/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
  });
});
