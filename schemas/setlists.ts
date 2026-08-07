import { z } from "zod";

// PUT /api/setlists/:id — full desired order of the songs already in the
// setlist. Position is derived from array index (1-indexed); it is NOT sent by
// the client. keyOverride null clears any override.
export const reorderSetlistSchema = z.object({
  // Bounded well above any real setlist size so an oversized payload is
  // rejected here rather than doing wasted work in the handler's
  // songId-set-mismatch check (app/api/setlists/[id]/handler.ts).
  songs: z
    .array(
      z.object({
        songId: z.string().uuid(),
        keyOverride: z.string().trim().min(1).max(5).nullish(),
        notes: z.string().trim().max(1000).nullish(),
      }),
    )
    .min(1)
    .max(50),
});
export type ReorderSetlistInput = z.infer<typeof reorderSetlistSchema>;

// POST /api/setlists/:id/songs — add one song.
export const addSetlistSongSchema = z.object({
  songId: z.string().uuid(),
  keyOverride: z.string().trim().min(1).max(5).nullish(),
});
export type AddSetlistSongInput = z.infer<typeof addSetlistSongSchema>;
