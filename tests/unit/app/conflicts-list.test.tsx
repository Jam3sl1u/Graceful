/** @jest-environment jsdom */
// Tests for the Conflicts list screen (#47/#50):
// app/(app)/conflicts/conflicts-list.tsx. `fetch` is mocked directly,
// mirroring tests/unit/app/conflict-resolution.test.tsx.

import { render, screen, waitFor } from "@testing-library/react";
import ConflictsList from "@/app/(app)/conflicts/conflicts-list";

const CONFLICT_ID = "44444444-4444-4444-4444-444444444444";

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

describe("ConflictsList", () => {
  it("shows a loading state before the fetch resolves", () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ConflictsList />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("happy path: renders a card per open conflict, linking to its resolution screen", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { conflicts: [baseConflict()] } }));
    render(<ConflictsList />);

    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("marked_unavailable")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /sunday service/i })).toHaveAttribute(
      "href",
      `/conflicts/${CONFLICT_ID}`,
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/conflicts");
  });

  it("empty state: no open conflicts renders a friendly message, not a blank page", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { conflicts: [] } }));
    render(<ConflictsList />);

    await waitFor(() => expect(screen.getByText(/no open conflicts/i)).toBeInTheDocument());
  });

  it("edge case: null serviceWeekTitle falls back to 'Service'", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { conflicts: [baseConflict({ serviceWeekTitle: null })] } }),
    );
    render(<ConflictsList />);

    await waitFor(() => expect(screen.getByText("Service")).toBeInTheDocument());
  });

  it("edge case: null triggerReason is omitted cleanly", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { conflicts: [baseConflict({ triggerReason: null })] } }),
    );
    render(<ConflictsList />);

    await waitFor(() => expect(screen.getByText("Jane Doe")).toBeInTheDocument());
    expect(screen.queryByText("marked_unavailable")).not.toBeInTheDocument();
  });

  it("failure case: 403 shows the forbidden view", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: "Insufficient permissions", code: "FORBIDDEN" }),
    );
    render(<ConflictsList />);

    await waitFor(() => expect(screen.getByText(/don.t have access/i)).toBeInTheDocument());
  });

  it("failure case: a non-OK, non-403 response shows the error view", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "Internal error", code: "INTERNAL" }));
    render(<ConflictsList />);

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument());
  });

  it("failure case: a network error shows the error view, not a crash", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    render(<ConflictsList />);

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument());
  });
});
