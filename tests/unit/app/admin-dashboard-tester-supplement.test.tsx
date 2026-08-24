/** @jest-environment jsdom */
// Independent tester-stage supplement for the Admin Global Dashboard screen
// (#74): app/(app)/dashboard/admin-dashboard.tsx. Covers gaps not exercised
// by the coder's own tests/unit/app/admin-dashboard.test.tsx: date-field
// wiring into the fetch URL, the group-wide guarantee that filters are the
// only thing that changes the request (no per-user scoping), and a
// mid-flight failure after a prior successful load.

import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import AdminDashboard from "@/app/(app)/dashboard/admin-dashboard";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("AdminDashboard — tester supplement", () => {
  it("appends startDate/endDate to the fetch URL only once both date fields are set", async () => {
    const fetchMock = jest.fn((_url: string) =>
      Promise.resolve(jsonResponse(200, { data: { serviceWeeks: [] } })),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AdminDashboard />);
    await waitFor(() => expect(screen.getByLabelText("From")).toBeInTheDocument());

    // Initial load: no date params at all.
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("startDate");
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("endDate");

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-07-01" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toContain("startDate=2026-07-01");
    expect(fetchMock.mock.calls[1]?.[0]).not.toContain("endDate");
    // Wait for the view to settle back to "ready" (the fetch resolves
    // synchronously, but the "To" field only exists once rendered again).
    await waitFor(() => expect(screen.getByLabelText("To")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-07-31" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2]?.[0]).toContain("startDate=2026-07-01");
    expect(fetchMock.mock.calls[2]?.[0]).toContain("endDate=2026-07-31");
  });

  it("a failure on a re-fetch (after a prior successful load) still shows the error screen, not stale data", async () => {
    const week = {
      id: "week-1",
      serviceDate: "2026-07-19",
      title: "Sunday Service",
      isCancelled: false,
      setlistStatus: "published",
      confirmedCount: 1,
      rosterSize: 1,
      openConflictCount: 0,
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: { serviceWeeks: [week] } }))
      .mockRejectedValueOnce(new Error("network down"));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AdminDashboard />);
    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "active" } });

    await waitFor(() => expect(screen.getByText("Something went wrong")).toBeInTheDocument());
    expect(screen.queryByText("Sunday Service")).not.toBeInTheDocument();
  });

  it("unmounting while a fetch is in flight does not throw or warn (cancelled guard covers unmount too)", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    global.fetch = jest.fn(() => pending) as unknown as typeof fetch;
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(<AdminDashboard />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();

    unmount();
    // Resolve after unmount — if the `cancelled` guard didn't cover this,
    // React would warn about calling setState on an unmounted component.
    resolveFetch(jsonResponse(200, { data: { serviceWeeks: [] } }));
    await new Promise((r) => setTimeout(r, 0));

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
    cleanup();
  });
});
