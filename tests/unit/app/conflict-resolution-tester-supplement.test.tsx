/** @jest-environment jsdom */
// Supplementary tests written independently by the Tester stage for #50
// (app/(app)/conflicts/[id]/conflict-resolution.tsx). The coder's own
// conflict-resolution.test.tsx already covers the happy path, the named
// edge cases (null roleNote/triggerReason/serviceWeekTitle), double-submit,
// 409, and a couple of failure cases (not-found, network error, non-OK
// resolve). This file closes a few gaps it leaves:
//
//   1. It never asserts that clicking "Find a Replacement" issues NO
//      additional request — the spec's core distinguishing behavior for
//      that button ("No API call. Conflict stays open.") is only ever
//      checked via its `href`, never behaviorally on click.
//   2. It never exercises a non-OK (e.g. 500) response on the *initial*
//      GET /api/conflicts lookup — only a thrown network error and a
//      well-formed-but-not-found list are covered, leaving the `!res.ok`
//      branch of the load effect unexercised.
//   3. It never asserts the encoded href when roleNote is null (the spec
//      explicitly calls for `encodeURIComponent(roleNote ?? "")`, i.e. an
//      empty-string param, not the literal string "null").

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ConflictResolution from "@/app/(app)/conflicts/[id]/conflict-resolution";

const CONFLICT_ID = "44444444-4444-4444-8444-444444444444";
const SERVICE_WEEK_ID = "22222222-2222-4222-8222-222222222222";

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

describe("ConflictResolution — tester supplement (#50)", () => {
  it('clicking "Find a Replacement" issues no additional request and the conflict stays on the ready view', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { conflicts: [baseConflict()] } }),
    );
    render(<ConflictResolution conflictId={CONFLICT_ID} />);

    const link = await screen.findByRole("link", { name: /find a replacement/i });
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial GET so far

    fireEvent.click(link);

    // No POST/second fetch fired, and the screen is still showing the ready
    // view (member name still present) rather than a resolved/unavailable one.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark as resolved/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
  });

  it("failure case: a non-OK (500) response on the initial lookup shows the unavailable view, not a crash", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, { error: "Internal error", code: "INTERNAL" }),
    );
    render(<ConflictResolution conflictId={CONFLICT_ID} />);

    await waitFor(() =>
      expect(screen.getByText(/resolved or no longer exists/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/INTERNAL/)).not.toBeInTheDocument();
  });

  it('"Find a Replacement" encodes a null roleNote as an empty string param, not the literal "null"', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { conflicts: [baseConflict({ roleNote: null })] } }),
    );
    render(<ConflictResolution conflictId={CONFLICT_ID} />);

    const link = await screen.findByRole("link", { name: /find a replacement/i });
    expect(link).toHaveAttribute(
      "href",
      `/invitations/new?serviceWeekId=${SERVICE_WEEK_ID}&roleNote=`,
    );
  });
});
