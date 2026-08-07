/** @jest-environment jsdom */
// Tests for the Admin Global Dashboard screen (#74):
// app/(app)/dashboard/admin-dashboard.tsx. Mirrors
// tests/unit/app/member-week-view.test.tsx: `fetch` is mocked directly.

import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import AdminDashboard from "@/app/(app)/dashboard/admin-dashboard";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const weeks = [
  {
    id: "week-1",
    serviceDate: "2026-07-19",
    title: "Sunday Service",
    isCancelled: false,
    setlistStatus: "published",
    confirmedCount: 5,
    rosterSize: 7,
    openConflictCount: 1,
  },
  {
    id: "week-2",
    serviceDate: "2026-07-12",
    title: "Midweek Prayer",
    isCancelled: true,
    setlistStatus: "draft",
    confirmedCount: 2,
    rosterSize: 2,
    openConflictCount: 2,
  },
  {
    id: "week-3",
    serviceDate: "2026-07-05",
    title: null,
    isCancelled: false,
    setlistStatus: null,
    confirmedCount: 0,
    rosterSize: 0,
    openConflictCount: 0,
  },
];

afterEach(() => {
  jest.restoreAllMocks();
});

describe("AdminDashboard", () => {
  it("shows a loading state before the fetch resolves", () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<AdminDashboard />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("happy path: renders fill rate, publish badges, cancelled badge, and open-conflict badges", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(jsonResponse(200, { data: { serviceWeeks: weeks } })),
    ) as unknown as typeof fetch;

    render(<AdminDashboard />);
    await waitFor(() => expect(screen.getByText("Sunday Service")).toBeInTheDocument());

    // Roster fill rate
    expect(screen.getByText("5 of 7 confirmed")).toBeInTheDocument();
    expect(screen.getByText("No one invited yet")).toBeInTheDocument();

    // Publish badges
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("No setlist")).toBeInTheDocument();

    // Cancelled badge only on week-2 (scope past the Status <select>'s own
    // "Cancelled" option, which also matches the text "Cancelled").
    const week2Card = screen.getByText("Midweek Prayer").closest("a") as HTMLElement;
    expect(within(week2Card).getByText("Cancelled")).toBeInTheDocument();

    // Untitled service fallback for week-3 (null title)
    expect(screen.getByText("Untitled service")).toBeInTheDocument();

    // Open-conflict badges: singular and plural forms
    expect(screen.getByText("1 open conflict")).toBeInTheDocument();
    expect(screen.getByText("2 open conflicts")).toBeInTheDocument();

    // Cards link into the existing Week View
    expect(screen.getByText("Sunday Service").closest("a")).toHaveAttribute(
      "href",
      "/week/week-1",
    );
  });

  it("renders the empty-list message when no weeks match the filters", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(jsonResponse(200, { data: { serviceWeeks: [] } })),
    ) as unknown as typeof fetch;

    render(<AdminDashboard />);
    await waitFor(() =>
      expect(screen.getByText("No service weeks match these filters.")).toBeInTheDocument(),
    );
  });

  it("changing the Status select re-fetches with status=cancelled in the URL", async () => {
    const fetchMock = jest.fn((_url: string) =>
      Promise.resolve(jsonResponse(200, { data: { serviceWeeks: [] } })),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AdminDashboard />);
    await waitFor(() => expect(screen.getByLabelText("Status")).toBeInTheDocument());
    expect(fetchMock.mock.calls[0]?.[0]).toContain("status=all");

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "cancelled" } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toContain("status=cancelled");
  });

  it("shows the forbidden screen on a 403 response", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(jsonResponse(403, { error: "Insufficient permissions", code: "FORBIDDEN" })),
    ) as unknown as typeof fetch;

    render(<AdminDashboard />);
    await waitFor(() =>
      expect(screen.getByText("You don't have access to this page")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("This screen is available to Set Leaders and Admins only."),
    ).toBeInTheDocument();
  });

  it("shows the error screen on a non-403 failure", async () => {
    global.fetch = jest.fn(() =>
      Promise.reject(new Error("network down")),
    ) as unknown as typeof fetch;

    render(<AdminDashboard />);
    await waitFor(() => expect(screen.getByText("Something went wrong")).toBeInTheDocument());
  });

  it("on a 400 response, keeps the filter controls rendered and shows an inline alert", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(jsonResponse(400, { error: "Validation failed", code: "VALIDATION_FAILED" })),
    ) as unknown as typeof fetch;

    render(<AdminDashboard />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Check the date range — the start date must be on or before the end date.",
    );
    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(screen.getByLabelText("To")).toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toBeInTheDocument();
    expect(
      screen.getByText("No service weeks match these filters."),
    ).toBeInTheDocument();
  });
});
