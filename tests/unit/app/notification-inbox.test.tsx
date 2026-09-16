/** @jest-environment jsdom */
// Tests for the Notification Inbox screen (#73):
// app/(app)/notifications/notification-inbox.tsx. `fetch` is mocked
// directly, mirroring tests/unit/app/conflicts-list.test.tsx.

import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import NotificationInbox from "@/app/(app)/notifications/notification-inbox";
import { UNREAD_CHANGED_EVENT } from "@/components/layout/NotificationBell";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function baseNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: "n1",
    type: "setlist_released",
    title: "New setlist released",
    body: "Check out this week's setlist.",
    linkEntityType: "setlist",
    linkEntityId: "s1",
    isRead: false,
    createdAt: "2026-01-10T11:59:00.000Z",
    ...overrides,
  };
}

function listResponse(notifications: unknown[], total = notifications.length) {
  return jsonResponse(200, {
    data: { notifications, pagination: { page: 1, pageSize: 50, total } },
  });
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("NotificationInbox", () => {
  it("shows a loading state before the fetch resolves", () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<NotificationInbox />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("happy path: renders a row per notification with title, body, and timestamp", async () => {
    fetchMock.mockResolvedValueOnce(listResponse([baseNotification()]));
    render(<NotificationInbox />);

    await waitFor(() => expect(screen.getByText("New setlist released")).toBeInTheDocument());
    expect(screen.getByText("Check out this week's setlist.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new setlist released/i })).toHaveAttribute(
      "href",
      "/setlists/s1",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/notifications?page=1&pageSize=50");
  });

  it("edge case: body === null renders no body paragraph (not the string 'null')", async () => {
    fetchMock.mockResolvedValueOnce(listResponse([baseNotification({ body: null })]));
    render(<NotificationInbox />);

    await waitFor(() => expect(screen.getByText("New setlist released")).toBeInTheDocument());
    expect(screen.queryByText("null")).not.toBeInTheDocument();
  });

  it("edge case: linkEntityId === null renders a non-clickable button row, still read-on-tap", async () => {
    fetchMock.mockResolvedValueOnce(
      listResponse([
        baseNotification({
          type: "google_calendar_event",
          linkEntityType: "google_calendar",
          linkEntityId: null,
        }),
      ]),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { notification: {} } }));
    render(<NotificationInbox />);

    await waitFor(() => expect(screen.getByText("New setlist released")).toBeInTheDocument());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    const card = screen.getByRole("button", { name: /new setlist released/i });
    expect(within(card).getByText("Check out this week's setlist.").tagName).toBe("SPAN");
    expect(card.querySelector("p")).toBeNull();
    fireEvent.click(card);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/notifications/n1/read", { method: "PATCH" }),
    );
  });

  it("edge case: unknown linkEntityType is non-clickable and never throws", async () => {
    fetchMock.mockResolvedValueOnce(
      listResponse([baseNotification({ linkEntityType: "some_future_type", linkEntityId: "x" })]),
    );
    render(<NotificationInbox />);

    await waitFor(() => expect(screen.getByText("New setlist released")).toBeInTheDocument());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("unread rows show a visually-hidden 'Unread' marker; read rows do not", async () => {
    fetchMock.mockResolvedValueOnce(
      listResponse([
        baseNotification({ id: "n1", isRead: false }),
        baseNotification({ id: "n2", title: "Already read", isRead: true }),
      ]),
    );
    render(<NotificationInbox />);

    await waitFor(() => expect(screen.getByText("New setlist released")).toBeInTheDocument());
    expect(screen.getAllByText("Unread")).toHaveLength(1);
  });

  it("Chat filter: no chat_mention notifications loaded renders the Chat empty state", async () => {
    fetchMock.mockResolvedValueOnce(listResponse([baseNotification()]));
    render(<NotificationInbox />);

    await waitFor(() => expect(screen.getByText("New setlist released")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    expect(screen.getByText("No Chat notifications.")).toBeInTheDocument();
    // Selecting a filter must not refetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("empty inbox: total === 0 shows 'No notifications yet.' and disables mark-all-read", async () => {
    fetchMock.mockResolvedValueOnce(listResponse([], 0));
    render(<NotificationInbox />);

    await waitFor(() => expect(screen.getByText("No notifications yet.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /mark all read/i })).toBeDisabled();
  });

  it("footnote: total > notifications.length renders the 'Showing N of Total' line", async () => {
    fetchMock.mockResolvedValueOnce(listResponse([baseNotification()], 5));
    render(<NotificationInbox />);

    await waitFor(() =>
      expect(
        screen.getByText("Showing the 1 most recent of 5 notifications."),
      ).toBeInTheDocument(),
    );
  });

  it("no footnote when total === notifications.length", async () => {
    fetchMock.mockResolvedValueOnce(listResponse([baseNotification()], 1));
    render(<NotificationInbox />);

    await waitFor(() => expect(screen.getByText("New setlist released")).toBeInTheDocument());
    expect(screen.queryByText(/most recent of/)).not.toBeInTheDocument();
  });

  it("mark-all-read: disabled when nothing is unread, issues no request", async () => {
    fetchMock.mockResolvedValueOnce(listResponse([baseNotification({ isRead: true })]));
    render(<NotificationInbox />);

    await waitFor(() => expect(screen.getByText("New setlist released")).toBeInTheDocument());
    const button = screen.getByRole("button", { name: /mark all read/i });
    expect(button).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mark-all-read: happy path flips all rows to read and dispatches the unread-changed event", async () => {
    fetchMock.mockResolvedValueOnce(listResponse([baseNotification()]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { updatedCount: 1 } }));

    const listener = jest.fn();
    window.addEventListener(UNREAD_CHANGED_EVENT, listener);

    render(<NotificationInbox />);
    await waitFor(() => expect(screen.getByText("New setlist released")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /mark all read/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/notifications/mark-all-read", {
        method: "POST",
      }),
    );
    await waitFor(() => expect(listener).toHaveBeenCalled());
    expect(screen.queryByText("Unread")).not.toBeInTheDocument();

    window.removeEventListener(UNREAD_CHANGED_EVENT, listener);
  });

  it("mark-all-read: HTTP failure leaves list state unchanged and shows an inline error, not a full error screen", async () => {
    fetchMock.mockResolvedValueOnce(listResponse([baseNotification()]));
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "Internal error" }));

    render(<NotificationInbox />);
    await waitFor(() => expect(screen.getByText("New setlist released")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /mark all read/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("New setlist released")).toBeInTheDocument();
    expect(screen.getAllByText("Unread")).toHaveLength(1);
  });

  it("tapping an already-read row issues no PATCH request", async () => {
    fetchMock.mockResolvedValueOnce(listResponse([baseNotification({ isRead: true })]));
    render(<NotificationInbox />);

    await waitFor(() => expect(screen.getByText("New setlist released")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("link", { name: /new setlist released/i }));

    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial list fetch
  });

  it("failure case: a non-OK response on the list fetch shows the error view", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "Internal error" }));
    render(<NotificationInbox />);

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument());
  });

  it("failure case: a network error on the list fetch shows the error view, not a crash", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    render(<NotificationInbox />);

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument());
  });
});
