/** @jest-environment jsdom */
// Tests for the Setlist Builder screen (#64):
// app/(app)/setlists/[id]/setlist-builder.tsx. Mirrors
// tests/unit/app/week-view.test.tsx: `fetch` is mocked directly, keyed by
// URL since this screen issues concurrent fetches on load.

import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import SetlistBuilder from "@/app/(app)/setlists/[id]/setlist-builder";

const SETLIST_ID = "11111111-1111-1111-1111-111111111111";
const SONG_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // in setlist, default key C
const SONG_2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; // in setlist, default key null
const SONG_3 = "cccccccc-cccc-cccc-cccc-cccccccccccc"; // catalog only, not in setlist

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const draftSetlist = { id: SETLIST_ID, status: "draft" };
const publishedSetlist = { id: SETLIST_ID, status: "published" };

const setlistSongs = [
  {
    songId: SONG_1,
    position: 1,
    keyOverride: null,
    defaultKey: "C",
    effectiveKey: "C",
    notes: null,
  },
  {
    songId: SONG_2,
    position: 2,
    keyOverride: null,
    defaultKey: null,
    effectiveKey: null,
    notes: "Slow intro",
  },
];

const catalog = [
  { id: SONG_1, title: "Amazing Grace", artist: "Traditional", defaultKey: "C" },
  { id: SONG_2, title: "How Great Thou Art", artist: null, defaultKey: null },
  { id: SONG_3, title: "10,000 Reasons", artist: "Matt Redman", defaultKey: "G" },
];

function mockFetchByUrl(overrides: Record<string, Response> = {}) {
  const defaults: Record<string, Response> = {
    [`/api/setlists/${SETLIST_ID}`]: jsonResponse(200, {
      data: { setlist: draftSetlist, songs: setlistSongs },
    }),
    [`/api/songs`]: jsonResponse(200, { data: { songs: catalog } }),
  };
  const responses = { ...defaults, ...overrides };

  return jest.fn((url: string) => {
    const match = responses[url];
    if (match) return Promise.resolve(match);
    return Promise.resolve(jsonResponse(404, { error: "not mocked", code: "NOT_FOUND" }));
  });
}

beforeEach(() => {
  global.fetch = mockFetchByUrl() as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Song titles appear in both the left search-results panel and the right
// setlist panel, so plain `screen.getByText` is ambiguous once a song is both
// in the catalog and in the setlist. These helpers scope queries to the
// correct panel/row.
function getSearchPanel(): HTMLElement {
  return screen.getByRole("heading", { name: "Song catalog", level: 2 }).closest("section") as HTMLElement;
}

function getSetlistPanel(): HTMLElement {
  return screen.getByRole("heading", { name: "Setlist", level: 2 }).closest("section") as HTMLElement;
}

function getSetlistRow(title: string): HTMLElement {
  return within(getSetlistPanel()).getByText(title).closest("li") as HTMLElement;
}

// Shape of one entry in the PUT /api/setlists/:id request body.
type PutSongEntry = { songId: string; keyOverride: string | null; notes: string | null };

describe("SetlistBuilder", () => {
  it("shows a loading state before the fetches resolve", () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("happy path: loads and renders the setlist rows, catalog search, and song count", async () => {
    render(<SetlistBuilder setlistId={SETLIST_ID} />);

    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());
    expect(screen.getByText("Draft")).toBeInTheDocument();
    // catalog search results (left panel)
    expect(within(getSearchPanel()).getByText("Amazing Grace")).toBeInTheDocument();
    expect(within(getSearchPanel()).getByText("How Great Thou Art")).toBeInTheDocument();
    expect(within(getSearchPanel()).getByText("10,000 Reasons")).toBeInTheDocument();
    // setlist rows (right panel), resolved via catalogById
    expect(getSetlistRow("Amazing Grace")).toBeInTheDocument();
    expect(getSetlistRow("How Great Thou Art")).toBeInTheDocument();
    expect(screen.getByText("2 songs")).toBeInTheDocument();
  });

  it("zero songs: empty state renders and Publish is still enabled", async () => {
    global.fetch = mockFetchByUrl({
      [`/api/setlists/${SETLIST_ID}`]: jsonResponse(200, {
        data: { setlist: draftSetlist, songs: [] },
      }),
    }) as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    expect(screen.getByText(/no songs yet/i)).toBeInTheDocument();
    expect(screen.getByText("0 songs")).toBeInTheDocument();
    const publishButton = screen.getByRole("button", { name: "Publish" });
    expect(publishButton).not.toBeDisabled();

    fireEvent.click(publishButton);
    expect(
      screen.getByText(/this setlist has no songs yet\. it will be published with no songs\./i),
    ).toBeInTheDocument();
  });

  it("search: filters the catalog by title/artist substring, case-insensitively", async () => {
    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/search songs/i);
    fireEvent.change(search, { target: { value: "redman" } });

    // "How Great Thou Art" is already in the setlist (right panel), so it
    // still renders there — the search only filters the catalog/search
    // results (left panel).
    expect(within(getSearchPanel()).getByText("10,000 Reasons")).toBeInTheDocument();
    expect(within(getSearchPanel()).queryByText("How Great Thou Art")).not.toBeInTheDocument();
    expect(within(getSearchPanel()).queryByText("Amazing Grace")).not.toBeInTheDocument();
  });

  it("search no match: shows the quick-add form prefilled with the search term", async () => {
    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/search songs/i);
    fireEvent.change(search, { target: { value: "Totally New Song" } });

    expect(screen.getByText("Add a new song")).toBeInTheDocument();
    expect(screen.getByLabelText(/title/i)).toHaveValue("Totally New Song");
  });

  it("search no match: prefilled title tracks the search term through incremental (letter-by-letter) typing, not just a single paste", async () => {
    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/search songs/i);
    // None of the fixture catalog's titles/artists contain "x", so every
    // prefix of this target (starting from the very first character) is
    // guaranteed to be a no-match and keep the quick-add form visible —
    // unlike e.g. "T", whose 1-character prefix substring-matches "How
    // Great Thou Art" and would suppress the form before typing even gets
    // going.
    const target = "Xylophone Jam 2000";

    // Simulate typing one character at a time (each fireEvent.change here
    // mirrors a single keystroke, unlike a single paste of the full string)
    // without ever touching the Title field directly.
    for (let i = 1; i <= target.length; i++) {
      const partial = target.slice(0, i);
      fireEvent.change(search, { target: { value: partial } });
      expect(screen.getByLabelText(/title/i)).toHaveValue(partial);
    }

    expect(screen.getByLabelText(/title/i)).toHaveValue(target);
  });

  it("search no match: further edits to the prefilled title are not clobbered by continued typing in the search box", async () => {
    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/search songs/i);
    fireEvent.change(search, { target: { value: "Totally New Song" } });
    expect(screen.getByLabelText(/title/i)).toHaveValue("Totally New Song");

    // user overrides the prefilled title by hand
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "My Custom Title" } });
    expect(screen.getByLabelText(/title/i)).toHaveValue("My Custom Title");

    // continuing to type in the search box (quick-add form stays visible,
    // still no catalog match) must not overwrite the user's edited title
    fireEvent.change(search, { target: { value: "Totally New Song 2" } });
    expect(screen.getByText("Add a new song")).toBeInTheDocument();
    expect(screen.getByLabelText(/title/i)).toHaveValue("My Custom Title");
  });

  it("duplicate add: a 409 from POST /songs shows an inline message and does not mutate local state", async () => {
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === `/api/setlists/${SETLIST_ID}/songs` && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(409, { error: "That song is already in the setlist.", code: "CONFLICT" }),
        );
      }
      return mockFetchByUrl()(url);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/search songs/i);
    fireEvent.change(search, { target: { value: "10,000 Reasons" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(screen.getByText(/already in the setlist/i)).toBeInTheDocument(),
    );
    // still 2 songs in the setlist panel, unaffected
    expect(screen.getByText("2 songs")).toBeInTheDocument();
  });

  it("quick-add flow: creates a song then adds it to the setlist", async () => {
    const newSong = { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", title: "Brand New Song", artist: null, defaultKey: null };
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === `/api/songs` && init?.method === "POST") {
        return Promise.resolve(jsonResponse(201, { data: { song: newSong } }));
      }
      if (url === `/api/setlists/${SETLIST_ID}/songs` && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        expect(body.songId).toBe(newSong.id);
        return Promise.resolve(
          jsonResponse(201, {
            data: {
              songs: [
                ...setlistSongs,
                {
                  songId: newSong.id,
                  position: 3,
                  keyOverride: null,
                  defaultKey: null,
                  effectiveKey: null,
                  notes: null,
                },
              ],
            },
          }),
        );
      }
      return mockFetchByUrl()(url);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/search songs/i);
    fireEvent.change(search, { target: { value: "Brand New Song" } });
    // Title is filled in directly here (independent of whether it is
    // prefilled from the search term — see the dedicated prefill test above)
    // so this test isolates the create-then-add flow itself.
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Brand New Song" } });
    fireEvent.click(screen.getByRole("button", { name: /add song/i }));

    await waitFor(() => expect(screen.getByText("3 songs")).toBeInTheDocument());
  });

  it("quick-add flow: a failed add-to-setlist after a successful song creation still leaves the title resyncable (not stuck blank)", async () => {
    const newSong = { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", title: "My Custom Title", artist: null, defaultKey: null };
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === `/api/songs` && init?.method === "POST") {
        return Promise.resolve(jsonResponse(201, { data: { song: newSong } }));
      }
      if (url === `/api/setlists/${SETLIST_ID}/songs` && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(409, { error: "That song is already in the setlist.", code: "CONFLICT" }),
        );
      }
      return mockFetchByUrl()(url);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/search songs/i);
    fireEvent.change(search, { target: { value: "Divergent Search Term" } });
    expect(screen.getByLabelText(/title/i)).toHaveValue("Divergent Search Term");

    // Diverge the title from the search term (marks it dirty), then submit.
    // The song gets created but the add-to-setlist call 409s — the title
    // whose new catalog entry doesn't match the still-unchanged search term
    // must not end up permanently stuck at "" once cleared.
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "My Custom Title" } });
    fireEvent.click(screen.getByRole("button", { name: /add song/i }));

    await waitFor(() => expect(screen.getByText("That song is already in the setlist.")).toBeInTheDocument());

    // The search term is unchanged and still matches nothing (the newly
    // created "My Custom Title" song doesn't match "Divergent Search Term"),
    // so the quick-add form is still showing and should have re-seeded from
    // the current search term rather than staying blank.
    expect(screen.getByLabelText(/title/i)).toHaveValue("Divergent Search Term");
  });

  it("key override: choosing a key different from default sends keyOverride; choosing the default sends null", async () => {
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === `/api/setlists/${SETLIST_ID}` && init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        return Promise.resolve(jsonResponse(200, { data: { songs: body.songs.map((s: PutSongEntry, i: number) => ({
          songId: s.songId,
          position: i + 1,
          keyOverride: s.keyOverride,
          defaultKey: setlistSongs.find((ss) => ss.songId === s.songId)?.defaultKey ?? null,
          effectiveKey: s.keyOverride ?? setlistSongs.find((ss) => ss.songId === s.songId)?.defaultKey ?? null,
          notes: s.notes,
        })) } }));
      }
      return mockFetchByUrl()(url);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    const row1 = getSetlistRow("Amazing Grace");
    const keySelect = within(row1).getByRole("combobox");

    // choose a non-default key -> keyOverride should be sent as that key
    fireEvent.change(keySelect, { target: { value: "D" } });

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([url, init]) => url === `/api/setlists/${SETLIST_ID}` && (init as RequestInit)?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      const entry = body.songs.find((s: PutSongEntry) => s.songId === SONG_1);
      expect(entry.keyOverride).toBe("D");
    });

    // choosing the song's own default key ("C") again clears the override (null)
    fireEvent.change(keySelect, { target: { value: "C" } });
    await waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(
        ([url, init]) => url === `/api/setlists/${SETLIST_ID}` && (init as RequestInit)?.method === "PUT",
      );
      const lastCall = putCalls[putCalls.length - 1];
      const body = JSON.parse((lastCall![1] as RequestInit).body as string);
      const entry = body.songs.find((s: PutSongEntry) => s.songId === SONG_1);
      expect(entry.keyOverride).toBeNull();
    });
  });

  it("a song with defaultKey === null: blank key option maps to null override", async () => {
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === `/api/setlists/${SETLIST_ID}` && init?.method === "PUT") {
        return Promise.resolve(jsonResponse(200, { data: { songs: setlistSongs } }));
      }
      return mockFetchByUrl()(url);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    const row2 = getSetlistRow("How Great Thou Art");
    const keySelect = within(row2).getByRole("combobox");
    expect(keySelect).toHaveValue(""); // effectiveKey is null -> blank

    fireEvent.change(keySelect, { target: { value: "" } }); // re-select blank (no-op semantically)
    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([url, init]) => url === `/api/setlists/${SETLIST_ID}` && (init as RequestInit)?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      const entry = body.songs.find((s: PutSongEntry) => s.songId === SONG_2);
      expect(entry.keyOverride).toBeNull();
    });
  });

  it("notes: persists on blur (not per keystroke), and empty text is sent as null", async () => {
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === `/api/setlists/${SETLIST_ID}` && init?.method === "PUT") {
        return Promise.resolve(jsonResponse(200, { data: { songs: setlistSongs } }));
      }
      return mockFetchByUrl()(url);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    const row1 = getSetlistRow("Amazing Grace");
    const notesInput = within(row1).getByPlaceholderText("Notes");

    // typing alone (no blur) must not trigger a PUT
    fireEvent.change(notesInput, { target: { value: "Play it loud" } });
    const putCallsBeforeBlur = fetchMock.mock.calls.filter(
      ([url, init]) => url === `/api/setlists/${SETLIST_ID}` && (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCallsBeforeBlur).toHaveLength(0);

    fireEvent.blur(notesInput);
    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([url, init]) => url === `/api/setlists/${SETLIST_ID}` && (init as RequestInit)?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      const entry = body.songs.find((s: PutSongEntry) => s.songId === SONG_1);
      expect(entry.notes).toBe("Play it loud");
    });
  });

  it("PUT failure shows an inline error and resyncs from GET /api/setlists/:id", async () => {
    let getCalls = 0;
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === `/api/setlists/${SETLIST_ID}` && init?.method === "PUT") {
        return Promise.resolve(jsonResponse(500, { error: "Internal error", code: "INTERNAL" }));
      }
      if (url === `/api/setlists/${SETLIST_ID}` && !init) {
        getCalls += 1;
      }
      return mockFetchByUrl()(url);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    const row1 = getSetlistRow("Amazing Grace");
    const notesInput = within(row1).getByPlaceholderText("Notes");
    fireEvent.change(notesInput, { target: { value: "Trigger a failing save" } });
    fireEvent.blur(notesInput);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    // resync GET was called at least once beyond the initial load
    await waitFor(() => expect(getCalls).toBeGreaterThan(1));
  });

  it("remove: DELETE removes the song and updates the count", async () => {
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === `/api/setlists/${SETLIST_ID}/songs/${SONG_1}` && init?.method === "DELETE") {
        return Promise.resolve(
          jsonResponse(200, {
            data: {
              songs: [{ ...setlistSongs[1], position: 1 }],
            },
          }),
        );
      }
      return mockFetchByUrl()(url);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    const row1 = getSetlistRow("Amazing Grace");
    fireEvent.click(within(row1).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.getByText("1 song")).toBeInTheDocument());
    // still present in the catalog/search panel; just no longer a setlist row
    expect(within(getSetlistPanel()).queryByText("Amazing Grace")).not.toBeInTheDocument();
  });

  it("publish: happy path opens confirmation, posts, and flips to the locked/published state", async () => {
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === `/api/setlists/${SETLIST_ID}/publish` && init?.method === "POST") {
        return Promise.resolve(jsonResponse(200, { data: { setlist: publishedSetlist } }));
      }
      return mockFetchByUrl()(url);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(screen.getByText(/confirmed members will be notified/i)).toBeInTheDocument();

    const modalPublishButtons = screen.getAllByRole("button", { name: "Publish" });
    fireEvent.click(modalPublishButtons[modalPublishButtons.length - 1]!);

    await waitFor(() => expect(screen.getByText("Published")).toBeInTheDocument());
    expect(
      screen.getByText(/this setlist is published and locked for editing/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /unlock to edit/i })).toBeInTheDocument();
  });

  it("publish: a 409 shows 'Setlist is already published.'", async () => {
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === `/api/setlists/${SETLIST_ID}/publish` && init?.method === "POST") {
        return Promise.resolve(jsonResponse(409, { error: "Setlist is already published.", code: "CONFLICT" }));
      }
      return mockFetchByUrl()(url);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const modalPublishButtons = screen.getAllByRole("button", { name: "Publish" });
    fireEvent.click(modalPublishButtons[modalPublishButtons.length - 1]!);

    await waitFor(() =>
      expect(screen.getByText("Setlist is already published.")).toBeInTheDocument(),
    );
  });

  it("published/locked state on initial load: disables editing controls and shows Unlock, which re-enables editing", async () => {
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === `/api/setlists/${SETLIST_ID}` && !init) {
        return Promise.resolve(
          jsonResponse(200, { data: { setlist: publishedSetlist, songs: setlistSongs } }),
        );
      }
      if (url === `/api/setlists/${SETLIST_ID}/unlock` && init?.method === "POST") {
        return Promise.resolve(jsonResponse(200, { data: { setlist: draftSetlist } }));
      }
      return mockFetchByUrl()(url);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());

    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    const row1 = getSetlistRow("Amazing Grace");
    expect(within(row1).getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(within(row1).getByRole("combobox")).toBeDisabled();
    expect(within(row1).getByPlaceholderText("Notes")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /unlock to edit/i }));

    await waitFor(() => expect(screen.getByText("Draft")).toBeInTheDocument());
    const row1Again = getSetlistRow("Amazing Grace");
    expect(within(row1Again).getByRole("button", { name: "Remove" })).not.toBeDisabled();
  });

  it("a 403 on the initial setlist fetch shows the forbidden view", async () => {
    global.fetch = mockFetchByUrl({
      [`/api/setlists/${SETLIST_ID}`]: jsonResponse(403, {
        error: "Insufficient permissions",
        code: "FORBIDDEN",
      }),
    }) as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText(/don.t have access/i)).toBeInTheDocument());
  });

  it("a 404 on the initial setlist fetch shows the not-found view", async () => {
    global.fetch = mockFetchByUrl({
      [`/api/setlists/${SETLIST_ID}`]: jsonResponse(404, { error: "Setlist not found", code: "NOT_FOUND" }),
    }) as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist not found")).toBeInTheDocument());
  });

  it("catalog load failure (non-403) degrades search to empty but still renders ready", async () => {
    global.fetch = mockFetchByUrl({
      [`/api/songs`]: jsonResponse(500, { error: "Internal error", code: "INTERNAL" }),
    }) as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText("Setlist Builder")).toBeInTheDocument());
    // setlist songs still resolve titles via catalog map; with an empty
    // catalog they fall back to the "Unknown song" placeholder rather than
    // crashing the whole screen.
    expect(screen.getAllByText("Unknown song").length).toBeGreaterThan(0);
  });

  it("failure case: a network error on the core fetches shows the error view", async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;

    render(<SetlistBuilder setlistId={SETLIST_ID} />);
    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument());
  });
});
