-- Migration: setlist_songs.song_id deferred FK — Sprint 3 pre-work
--
-- setlist_songs.song_id (20260702000003_cluster_3_scheduling_core.sql) was
-- created with no FK constraint because `songs` did not exist yet at that
-- point in the migration sequence; that file's own comment says to add
-- `alter table setlist_songs add constraint setlist_songs_song_id_fkey
-- foreign key (song_id) references songs(id);` once `songs` exists.
-- 20260702000004_cluster_4_partial_songs.sql created `songs` and explicitly
-- deferred adding this constraint to a later migration (its own comment:
-- "that is intentionally NOT done in this migration"), which never
-- followed. Add it now, ahead of Sprint 3 (#55 add/remove/reorder setlist
-- songs) relying on setlist_songs for real. No ON DELETE clause, matching
-- the originally-drafted SQL exactly (defaults to NO ACTION/RESTRICT — a
-- song referenced by a setlist cannot be deleted out from under it).

-- ============ UP ============

ALTER TABLE setlist_songs
  ADD CONSTRAINT setlist_songs_song_id_fkey FOREIGN KEY (song_id) REFERENCES songs(id);

-- ============ DOWN ============

ALTER TABLE setlist_songs DROP CONSTRAINT setlist_songs_song_id_fkey;
