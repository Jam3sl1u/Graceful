"use client";

import { useEffect, useState, type DragEvent, type FormEvent } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SONG_KEY_OPTIONS } from "@/schemas/songs";
import styles from "./setlist-builder.module.css";

// Data shapes mirror the `{ data }`-wrapped response bodies of the endpoints
// this screen reads (types/api.ts envelope). Kept local/minimal (only the
// fields this screen actually uses) rather than importing server-only
// handler types into a client component.
type CatalogSong = {
  id: string;
  title: string;
  artist: string | null;
  defaultKey: string | null;
};

type SetlistSong = {
  songId: string;
  position: number;
  keyOverride: string | null;
  defaultKey: string | null;
  effectiveKey: string | null;
  notes: string | null;
};

type SetlistMeta = {
  id: string;
  status: "draft" | "published";
};

type ViewState = "loading" | "ready" | "forbidden" | "not-found" | "error";

// Shared by the quick-add-seeding effect and the render-time catalog filter
// so the two never drift out of sync on what counts as "no match".
function filterCatalog(catalog: CatalogSong[], term: string): CatalogSong[] {
  return catalog.filter(
    (c) => c.title.toLowerCase().includes(term) || (c.artist ?? "").toLowerCase().includes(term),
  );
}

export default function SetlistBuilder({ setlistId }: { setlistId: string }) {
  const [view, setView] = useState<ViewState>("loading");
  const [meta, setMeta] = useState<SetlistMeta | null>(null);
  const [songs, setSongs] = useState<SetlistSong[]>([]);
  const [catalog, setCatalog] = useState<CatalogSong[]>([]);

  const [searchTerm, setSearchTerm] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const [quickAddTitle, setQuickAddTitle] = useState("");
  const [quickAddArtist, setQuickAddArtist] = useState("");
  const [quickAddKey, setQuickAddKey] = useState("");
  const [quickAddError, setQuickAddError] = useState<string | null>(null);
  const [quickAddTitleDirty, setQuickAddTitleDirty] = useState(false);

  const [persistError, setPersistError] = useState<string | null>(null);
  const [draggedSongId, setDraggedSongId] = useState<string | null>(null);

  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [setlistRes, catalogRes] = await Promise.all([
          fetch(`/api/setlists/${setlistId}`),
          fetch(`/api/songs`),
        ]);
        if (cancelled) return;

        if (setlistRes.status === 403) {
          setView("forbidden");
          return;
        }
        if (setlistRes.status === 404) {
          setView("not-found");
          return;
        }
        if (!setlistRes.ok) {
          setView("error");
          return;
        }

        const setlistBody = await setlistRes.json();
        const setlistData = setlistBody.data.setlist;
        const songsData: SetlistSong[] = setlistBody.data.songs;

        // Non-critical: the catalog is used for search + title/artist lookup.
        // A failure here degrades search to empty rather than failing the
        // whole screen, except a 403 (which means this user shouldn't be
        // here at all).
        if (catalogRes.status === 403) {
          setView("forbidden");
          return;
        }
        let catalogData: CatalogSong[] = [];
        if (catalogRes.ok) {
          try {
            const catalogBody = await catalogRes.json();
            catalogData = catalogBody.data.songs;
          } catch {
            catalogData = [];
          }
        }

        if (cancelled) return;

        setSongs([...songsData].sort((a, b) => a.position - b.position));
        setMeta({ id: setlistData.id, status: setlistData.status });
        setCatalog(catalogData);
        setView("ready");
      } catch {
        if (!cancelled) setView("error");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [setlistId]);

  useEffect(() => {
    const term = searchTerm.trim().toLowerCase();
    const showQuickAdd = term !== "" && filterCatalog(catalog, term).length === 0;

    if (showQuickAdd) {
      if (!quickAddTitleDirty) {
        setQuickAddTitle(searchTerm);
      }
    } else {
      setQuickAddTitleDirty(false);
    }
  }, [searchTerm, catalog, quickAddTitleDirty]);

  const isLocked = meta?.status === "published";
  const catalogById = new Map(catalog.map((c) => [c.id, c]));

  // Re-reads the setlist after a failed PUT so the client resyncs with the
  // authoritative server state rather than staying on a stale optimistic
  // local update.
  async function reloadSetlist() {
    try {
      const res = await fetch(`/api/setlists/${setlistId}`);
      if (!res.ok) return;
      const body = await res.json();
      setSongs([...(body.data.songs as SetlistSong[])].sort((a, b) => a.position - b.position));
      setMeta({ id: body.data.setlist.id, status: body.data.setlist.status });
    } catch {
      // ignore; an inline error is already surfacing to the user
    }
  }

  // Single persistence mechanism for reorder + key overrides + notes: always
  // sends the full current song set in the desired display order (the
  // endpoint derives position from array index and requires exact
  // membership match).
  async function persistSongs(nextSongs: SetlistSong[]) {
    setSongs(nextSongs);
    setPersistError(null);
    try {
      const res = await fetch(`/api/setlists/${setlistId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          songs: nextSongs.map((s) => ({
            songId: s.songId,
            keyOverride: s.keyOverride,
            notes: s.notes,
          })),
        }),
      });
      if (!res.ok) {
        setPersistError("Something went wrong saving your changes.");
        await reloadSetlist();
        return;
      }
      const body = await res.json();
      setSongs([...(body.data.songs as SetlistSong[])].sort((a, b) => a.position - b.position));
    } catch {
      setPersistError("Something went wrong saving your changes.");
      await reloadSetlist();
    }
  }

  async function handleAdd(songId: string) {
    setAddError(null);
    try {
      const res = await fetch(`/api/setlists/${setlistId}/songs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songId }),
      });
      if (res.status === 409) {
        setAddError("That song is already in the setlist.");
        return;
      }
      if (!res.ok) {
        setAddError("Something went wrong adding that song.");
        return;
      }
      const body = await res.json();
      setSongs([...(body.data.songs as SetlistSong[])].sort((a, b) => a.position - b.position));
      setSearchTerm("");
    } catch {
      setAddError("Something went wrong adding that song.");
    }
  }

  async function handleQuickAdd(e: FormEvent) {
    e.preventDefault();
    setQuickAddError(null);
    const title = quickAddTitle.trim();
    if (title === "") {
      setQuickAddError("Title is required.");
      return;
    }
    try {
      const res = await fetch(`/api/songs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          artist: quickAddArtist.trim() === "" ? undefined : quickAddArtist.trim(),
          default_key: quickAddKey === "" ? undefined : quickAddKey,
        }),
      });
      if (!res.ok) {
        setQuickAddError("Something went wrong creating that song.");
        return;
      }
      const body = await res.json();
      const song: CatalogSong = body.data.song;
      setCatalog((prev) => [...prev, song]);
      await handleAdd(song.id);
      setQuickAddTitle("");
      setQuickAddArtist("");
      setQuickAddKey("");
      setQuickAddTitleDirty(false);
    } catch {
      setQuickAddError("Something went wrong creating that song.");
    }
  }

  async function handleRemove(songId: string) {
    setPersistError(null);
    try {
      const res = await fetch(`/api/setlists/${setlistId}/songs/${songId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setPersistError("Something went wrong removing that song.");
        return;
      }
      const body = await res.json();
      setSongs([...(body.data.songs as SetlistSong[])].sort((a, b) => a.position - b.position));
    } catch {
      setPersistError("Something went wrong removing that song.");
    }
  }

  function handleKeyChange(songId: string, newValue: string) {
    const song = songs.find((s) => s.songId === songId);
    if (!song) return;
    const chosen = newValue === "" ? null : newValue;
    const keyOverride = chosen === song.defaultKey ? null : chosen;
    const next = songs.map((s) =>
      s.songId === songId
        ? { ...s, keyOverride, effectiveKey: keyOverride ?? s.defaultKey }
        : s,
    );
    void persistSongs(next);
  }

  function handleNotesBlur(songId: string, value: string) {
    const trimmed = value.trim();
    const notes = trimmed === "" ? null : trimmed;
    const song = songs.find((s) => s.songId === songId);
    if (!song || song.notes === notes) return;
    const next = songs.map((s) => (s.songId === songId ? { ...s, notes } : s));
    void persistSongs(next);
  }

  function handleDragStart(e: DragEvent<HTMLLIElement>, songId: string) {
    setDraggedSongId(songId);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e: DragEvent<HTMLLIElement>) {
    e.preventDefault();
  }

  function handleDrop(e: DragEvent<HTMLLIElement>, targetSongId: string) {
    e.preventDefault();
    const from = draggedSongId;
    setDraggedSongId(null);
    if (!from || from === targetSongId) return;

    const fromIndex = songs.findIndex((s) => s.songId === from);
    const toIndex = songs.findIndex((s) => s.songId === targetSongId);
    if (fromIndex === -1 || toIndex === -1) return;

    const next = [...songs];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    void persistSongs(next);
  }

  async function handlePublish() {
    setPublishError(null);
    try {
      const res = await fetch(`/api/setlists/${setlistId}/publish`, { method: "POST" });
      if (res.status === 409) {
        setPublishError("Setlist is already published.");
        return;
      }
      if (!res.ok) {
        setPublishError("Something went wrong publishing the setlist.");
        return;
      }
      const body = await res.json();
      setMeta({ id: body.data.setlist.id, status: body.data.setlist.status });
      setPublishModalOpen(false);
    } catch {
      setPublishError("Something went wrong publishing the setlist.");
    }
  }

  async function handleUnlock() {
    setUnlockError(null);
    try {
      const res = await fetch(`/api/setlists/${setlistId}/unlock`, { method: "POST" });
      if (!res.ok) {
        setUnlockError("Something went wrong unlocking the setlist.");
        return;
      }
      const body = await res.json();
      setMeta({ id: body.data.setlist.id, status: body.data.setlist.status });
    } catch {
      setUnlockError("Something went wrong unlocking the setlist.");
    }
  }

  if (view === "loading") {
    return (
      <main className={styles.container}>
        <p>Loading…</p>
      </main>
    );
  }

  if (view === "forbidden") {
    return (
      <main className={styles.container}>
        <h1>You don&apos;t have access to this page</h1>
        <p>This screen is available to Set Leaders and Admins only.</p>
      </main>
    );
  }

  if (view === "not-found") {
    return (
      <main className={styles.container}>
        <h1>Setlist not found</h1>
      </main>
    );
  }

  if (view === "error") {
    return (
      <main className={styles.container}>
        <h1>Something went wrong</h1>
        <p>Please try again later.</p>
      </main>
    );
  }

  // ready
  if (!meta) return null;

  const term = searchTerm.trim().toLowerCase();
  const filteredCatalog = filterCatalog(catalog, term);
  const showQuickAdd = term !== "" && filteredCatalog.length === 0;
  const songIds = new Set(songs.map((s) => s.songId));

  return (
    <main className={styles.container}>
      <header className={styles.header}>
        <h1>Setlist Builder</h1>
        <Badge tone={isLocked ? "success" : "neutral"}>
          {isLocked ? "Published" : "Draft"}
        </Badge>
      </header>

      {isLocked ? (
        <div className={styles.lockedBanner}>
          <p>This setlist is published and locked for editing.</p>
          {unlockError ? (
            <p role="alert" className={styles.error}>
              {unlockError}
            </p>
          ) : null}
          <Button variant="secondary" type="button" onClick={handleUnlock}>
            Unlock to edit
          </Button>
        </div>
      ) : null}

      <div className={styles.layout}>
        <section className={styles.searchPanel}>
          <h2>Song catalog</h2>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Search songs…"
            value={searchTerm}
            disabled={isLocked}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {addError ? (
            <p role="alert" className={styles.error}>
              {addError}
            </p>
          ) : null}
          <ul className={styles.resultList}>
            {filteredCatalog.map((song) => (
              <li key={song.id} className={styles.resultRow}>
                <div>
                  <span className={styles.resultTitle}>{song.title}</span>
                  {song.artist ? <span className={styles.resultArtist}> — {song.artist}</span> : null}
                  {song.defaultKey ? <span className={styles.resultKey}> ({song.defaultKey})</span> : null}
                </div>
                <Button
                  variant="secondary"
                  type="button"
                  disabled={isLocked || songIds.has(song.id)}
                  onClick={() => handleAdd(song.id)}
                >
                  {songIds.has(song.id) ? "Added" : "Add"}
                </Button>
              </li>
            ))}
          </ul>

          {showQuickAdd ? (
            <form className={styles.quickAddForm} onSubmit={handleQuickAdd}>
              <h3>Add a new song</h3>
              {quickAddError ? (
                <p role="alert" className={styles.error}>
                  {quickAddError}
                </p>
              ) : null}
              <label>
                Title
                <input
                  type="text"
                  required
                  value={quickAddTitle}
                  disabled={isLocked}
                  onChange={(e) => {
                    setQuickAddTitle(e.target.value);
                    setQuickAddTitleDirty(true);
                  }}
                />
              </label>
              <label>
                Artist
                <input
                  type="text"
                  value={quickAddArtist}
                  disabled={isLocked}
                  onChange={(e) => setQuickAddArtist(e.target.value)}
                />
              </label>
              <label>
                Key
                <select
                  value={quickAddKey}
                  disabled={isLocked}
                  onChange={(e) => setQuickAddKey(e.target.value)}
                >
                  <option value="">— none —</option>
                  {SONG_KEY_OPTIONS.map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
              </label>
              <Button variant="primary" type="submit" disabled={isLocked}>
                Add song
              </Button>
            </form>
          ) : null}
        </section>

        <section className={styles.setlistPanel}>
          <h2>Setlist</h2>
          {persistError ? (
            <p role="alert" className={styles.error}>
              {persistError}
            </p>
          ) : null}
          {songs.length === 0 ? (
            <p>No songs yet — add some from the catalog.</p>
          ) : (
            <ol className={styles.setlistRows}>
              {songs.map((song) => {
                const catalogSong = catalogById.get(song.songId);
                return (
                  <li
                    key={song.songId}
                    className={styles.setlistRow}
                    draggable={!isLocked}
                    onDragStart={(e) => handleDragStart(e, song.songId)}
                    onDragOver={handleDragOver}
                    onDrop={(e) => handleDrop(e, song.songId)}
                  >
                    <span className={styles.dragHandle} aria-hidden="true">
                      ⠿
                    </span>
                    <span className={styles.position}>{song.position}</span>
                    <div className={styles.songInfo}>
                      <span className={styles.resultTitle}>{catalogSong?.title ?? "Unknown song"}</span>
                      {catalogSong?.artist ? (
                        <span className={styles.resultArtist}> — {catalogSong.artist}</span>
                      ) : null}
                    </div>
                    <select
                      value={song.effectiveKey ?? ""}
                      disabled={isLocked}
                      onChange={(e) => handleKeyChange(song.songId, e.target.value)}
                    >
                      <option value="">— none —</option>
                      {SONG_KEY_OPTIONS.map((key) => (
                        <option key={key} value={key}>
                          {key}
                        </option>
                      ))}
                    </select>
                    <input
                      key={song.songId}
                      type="text"
                      className={styles.notesInput}
                      placeholder="Notes"
                      defaultValue={song.notes ?? ""}
                      disabled={isLocked}
                      onBlur={(e) => handleNotesBlur(song.songId, e.target.value)}
                    />
                    <Button
                      variant="secondary"
                      type="button"
                      disabled={isLocked}
                      onClick={() => handleRemove(song.songId)}
                    >
                      Remove
                    </Button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>

      <div className={styles.bottomBar}>
        <span>{songs.length === 1 ? "1 song" : `${songs.length} songs`}</span>
        <Button
          variant="primary"
          type="button"
          disabled={isLocked}
          onClick={() => setPublishModalOpen(true)}
        >
          Publish
        </Button>
      </div>

      <Modal open={publishModalOpen} onClose={() => setPublishModalOpen(false)}>
        <h2>Publish this setlist?</h2>
        {songs.length === 0 ? (
          <p>This setlist has no songs yet. It will be published with no songs.</p>
        ) : (
          <p>Confirmed members will be notified once you publish.</p>
        )}
        {publishError ? (
          <p role="alert" className={styles.error}>
            {publishError}
          </p>
        ) : null}
        <div className={styles.modalActions}>
          <Button variant="secondary" type="button" onClick={() => setPublishModalOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="button" onClick={handlePublish}>
            Publish
          </Button>
        </div>
      </Modal>
    </main>
  );
}
