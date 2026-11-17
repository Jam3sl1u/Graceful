"use client";

import { useEffect, useState, type DragEvent, type FormEvent } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { InputField, SelectField, controlClassName } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { Page } from "@/components/ui/Page";
import {
  EmptyState,
  ErrorAlert,
  ErrorState,
  LoadingState,
  NoAccessState,
  NoticeState,
} from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
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
  const [publishing, setPublishing] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Announced to screen readers after a keyboard reorder.
  const [reorderMessage, setReorderMessage] = useState("");
  const { toast } = useToast();

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
  }, [setlistId, reloadKey]);

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

  // Keyboard- and touch-accessible alternative to drag-and-drop: same
  // persistence path (persistSongs), just a one-step move.
  function handleMove(songId: string, direction: -1 | 1) {
    const fromIndex = songs.findIndex((s) => s.songId === songId);
    const toIndex = fromIndex + direction;
    if (fromIndex === -1 || toIndex < 0 || toIndex >= songs.length) return;
    const next = [...songs];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    const title = catalogById.get(songId)?.title ?? "Song";
    setReorderMessage(`${title} moved to position ${toIndex + 1} of ${songs.length}`);
    void persistSongs(next);
  }

  async function handlePublish() {
    if (publishing) return;
    setPublishing(true);
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
      toast("Setlist published");
    } catch {
      setPublishError("Something went wrong publishing the setlist.");
    } finally {
      setPublishing(false);
    }
  }

  async function handleUnlock() {
    if (unlocking) return;
    setUnlocking(true);
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
    } finally {
      setUnlocking(false);
    }
  }

  const scheduleLink = (
    <ButtonLink href="/dashboard" variant="secondary">
      Back to schedule
    </ButtonLink>
  );

  if (view === "loading") {
    return (
      <Page width="wide">
        <LoadingState cards={2} />
      </Page>
    );
  }

  if (view === "forbidden") {
    return (
      <Page width="wide">
        <NoAccessState
          actions={
            <ButtonLink href="/notifications" variant="secondary">
              Go to notifications
            </ButtonLink>
          }
        >
          This screen is available to Set Leaders and Admins only.
        </NoAccessState>
      </Page>
    );
  }

  if (view === "not-found") {
    return (
      <Page width="wide">
        <NoticeState icon="music" tone="info" title="Setlist not found" actions={scheduleLink}>
          It may have been removed, or the link may be incomplete.
        </NoticeState>
      </Page>
    );
  }

  if (view === "error") {
    return (
      <Page width="wide">
        <ErrorState
          onRetry={() => {
            setView("loading");
            setReloadKey((k) => k + 1);
          }}
          actions={scheduleLink}
        />
      </Page>
    );
  }

  // ready
  if (!meta) return null;

  const term = searchTerm.trim().toLowerCase();
  const filteredCatalog = filterCatalog(catalog, term);
  const showQuickAdd = term !== "" && filteredCatalog.length === 0;
  const songIds = new Set(songs.map((s) => s.songId));

  return (
    <Page width="wide" className={styles.page}>
      <header className={styles.header}>
        <h1>Setlist Builder</h1>
        <Badge tone={isLocked ? "success" : "neutral"}>
          {isLocked ? "Published" : "Draft"}
        </Badge>
      </header>

      {isLocked ? (
        <div className={styles.lockedBanner}>
          <Icon name="lock" />
          <div className={styles.lockedText}>
            <p>This setlist is published and locked for editing.</p>
            {unlockError ? <ErrorAlert>{unlockError}</ErrorAlert> : null}
          </div>
          <Button variant="secondary" onClick={handleUnlock} disabled={unlocking} loading={unlocking}>
            Unlock to edit
          </Button>
        </div>
      ) : null}

      <div className={styles.layout}>
        <Card as="section" className={styles.searchPanel} aria-labelledby="sb-catalog">
          <h2 id="sb-catalog">Song catalog</h2>
          <label htmlFor="sb-search" className="sr-only">
            Search the song catalog
          </label>
          <div className={styles.searchWrap}>
            <Icon name="search" size={18} className={styles.searchIcon} />
            <input
              id="sb-search"
              type="search"
              className={`${controlClassName} ${styles.searchInput}`}
              placeholder="Search songs…"
              value={searchTerm}
              disabled={isLocked}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          {addError ? <ErrorAlert>{addError}</ErrorAlert> : null}
          {catalog.length === 0 ? (
            <EmptyState icon="music" title="Your catalog is empty">
              Search for a title to add your first song.
            </EmptyState>
          ) : null}
          <ul className={styles.resultList}>
            {filteredCatalog.map((song) => (
              <li key={song.id} className={styles.resultRow}>
                <div className={styles.resultText} id={`sb-catalog-${song.id}`}>
                  <span className={styles.resultTitle}>{song.title}</span>
                  {song.artist ? <span className={styles.resultArtist}> — {song.artist}</span> : null}
                  {song.defaultKey ? <span className={styles.resultKey}> ({song.defaultKey})</span> : null}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isLocked || songIds.has(song.id)}
                  aria-describedby={`sb-catalog-${song.id}`}
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
              <p className={styles.muted}>Nothing in the catalog matches. Create it here.</p>
              {quickAddError ? <ErrorAlert>{quickAddError}</ErrorAlert> : null}
              <InputField
                label="Title"
                type="text"
                required
                value={quickAddTitle}
                disabled={isLocked}
                onChange={(e) => {
                  setQuickAddTitle(e.target.value);
                  setQuickAddTitleDirty(true);
                }}
              />
              <InputField
                label="Artist"
                optional
                type="text"
                value={quickAddArtist}
                disabled={isLocked}
                onChange={(e) => setQuickAddArtist(e.target.value)}
              />
              <SelectField
                label="Key"
                optional
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
              </SelectField>
              <Button variant="primary" type="submit" disabled={isLocked}>
                Add song
              </Button>
            </form>
          ) : null}
        </Card>

        <Card as="section" className={styles.setlistPanel} aria-labelledby="sb-setlist">
          <h2 id="sb-setlist">Setlist</h2>
          {persistError ? <ErrorAlert>{persistError}</ErrorAlert> : null}
          <span className="sr-only" role="status">
            {reorderMessage}
          </span>
          {songs.length === 0 ? (
            <EmptyState icon="music" title="No songs yet — add some from the catalog." />
          ) : (
            <ol className={styles.setlistRows}>
              {songs.map((song, index) => {
                const catalogSong = catalogById.get(song.songId);
                const title = catalogSong?.title ?? "Unknown song";
                return (
                  <li
                    key={song.songId}
                    className={`${styles.setlistRow} ${
                      draggedSongId === song.songId ? styles.dragging : ""
                    }`}
                    draggable={!isLocked}
                    onDragStart={(e) => handleDragStart(e, song.songId)}
                    onDragOver={handleDragOver}
                    onDrop={(e) => handleDrop(e, song.songId)}
                  >
                    <div className={styles.rowTop}>
                      <span className={styles.dragHandle} aria-hidden="true">
                        <Icon name="grip" size={18} />
                      </span>
                      <span className={styles.position}>{song.position}</span>
                      <div className={styles.songInfo} id={`sb-song-${song.songId}`}>
                        <span className={styles.resultTitle}>{title}</span>
                        {catalogSong?.artist ? (
                          <span className={styles.resultArtist}> — {catalogSong.artist}</span>
                        ) : null}
                      </div>
                      <div className={styles.moveButtons}>
                        <button
                          type="button"
                          className={styles.iconButton}
                          aria-label={`Move ${title} up`}
                          disabled={isLocked || index === 0}
                          onClick={() => handleMove(song.songId, -1)}
                        >
                          <Icon name="arrowUp" size={18} />
                        </button>
                        <button
                          type="button"
                          className={styles.iconButton}
                          aria-label={`Move ${title} down`}
                          disabled={isLocked || index === songs.length - 1}
                          onClick={() => handleMove(song.songId, 1)}
                        >
                          <Icon name="arrowDown" size={18} />
                        </button>
                      </div>
                    </div>
                    <div className={styles.rowControls}>
                      <select
                        className={`${controlClassName} ${styles.keySelect}`}
                        aria-label={`Key for ${title}`}
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
                        className={`${controlClassName} ${styles.notesInput}`}
                        placeholder="Notes"
                        aria-label={`Notes for ${title}`}
                        defaultValue={song.notes ?? ""}
                        disabled={isLocked}
                        onBlur={(e) => handleNotesBlur(song.songId, e.target.value)}
                      />
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={isLocked}
                        aria-describedby={`sb-song-${song.songId}`}
                        onClick={() => handleRemove(song.songId)}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>
      </div>

      <div className={styles.bottomBar}>
        <span className={styles.count}>
          {songs.length === 1 ? "1 song" : `${songs.length} songs`}
        </span>
        <Button variant="accent" disabled={isLocked} onClick={() => setPublishModalOpen(true)}>
          Publish
        </Button>
      </div>

      <Modal
        open={publishModalOpen}
        onClose={() => setPublishModalOpen(false)}
        title="Publish this setlist?"
      >
        {songs.length === 0 ? (
          <p>This setlist has no songs yet. It will be published with no songs.</p>
        ) : (
          <p>Confirmed members will be notified once you publish.</p>
        )}
        {publishError ? (
          <div className={styles.modalError}>
            <ErrorAlert>{publishError}</ErrorAlert>
          </div>
        ) : null}
        <div className={styles.modalActions}>
          <Button variant="secondary" onClick={() => setPublishModalOpen(false)}>
            Cancel
          </Button>
          <Button variant="accent" onClick={handlePublish} disabled={publishing} loading={publishing}>
            Publish
          </Button>
        </div>
      </Modal>
    </Page>
  );
}
