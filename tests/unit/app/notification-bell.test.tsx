/** @jest-environment jsdom */
// Tests for components/layout/NotificationBell.tsx (#73): fetches unread
// count on mount, refreshes on the custom UNREAD_CHANGED_EVENT, and fails
// silently. `fetch` mocking mirrors tests/unit/app/conflicts-list.test.tsx.

import { act, render, screen, waitFor } from "@testing-library/react";
import {
  NotificationBell,
  UNREAD_CHANGED_EVENT,
  notifyUnreadChanged,
} from "@/components/layout/NotificationBell";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("NotificationBell", () => {
  it("happy path: renders a badge with the unread count", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { unreadCount: 5 } }));
    render(<NotificationBell />);

    await waitFor(() => expect(screen.getByText("5")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Notifications" })).toHaveAttribute(
      "href",
      "/notifications",
    );
    expect(screen.getByLabelText("5 unread notifications")).toBeInTheDocument();
  });

  it("edge case: unreadCount === 0 renders no badge at all", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { unreadCount: 0 } }));
    render(<NotificationBell />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText(/unread notifications/)).not.toBeInTheDocument();
  });

  it("edge case: unreadCount > 99 renders '99+'", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { unreadCount: 143 } }));
    render(<NotificationBell />);

    await waitFor(() => expect(screen.getByText("99+")).toBeInTheDocument());
  });

  it("refreshes when UNREAD_CHANGED_EVENT fires", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: { unreadCount: 0 } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { unreadCount: 7 } }));

    render(<NotificationBell />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => {
      notifyUnreadChanged();
    });

    await waitFor(() => expect(screen.getByText("7")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("notifyUnreadChanged dispatches the documented event name", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { unreadCount: 0 } }));
    const listener = jest.fn();
    window.addEventListener(UNREAD_CHANGED_EVENT, listener);

    act(() => {
      notifyUnreadChanged();
    });

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(UNREAD_CHANGED_EVENT, listener);
  });

  it("failure case: a non-OK response renders no badge and no error UI", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "Internal error" }));
    render(<NotificationBell />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText(/unread notifications/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Notifications" })).toBeInTheDocument();
  });

  it("failure case: a network error renders no badge and no error UI", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    render(<NotificationBell />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText(/unread notifications/)).not.toBeInTheDocument();
  });
});
