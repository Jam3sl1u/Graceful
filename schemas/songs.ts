import { z } from "zod";

// BR-09 (PRD §8, line 186): the 12 chromatic pitch classes, spelled both
// ASCII (real JSON/HTTP clients) and Unicode accidentals (the literal PRD
// list). No E#/B#/Cb/Fb. Match is case-sensitive and exact.
const ASCII_SONG_KEYS = [
  "C",
  "C#",
  "Db",
  "D",
  "D#",
  "Eb",
  "E",
  "F",
  "F#",
  "Gb",
  "G",
  "G#",
  "Ab",
  "A",
  "A#",
  "Bb",
  "B",
] as const;

const UNICODE_SONG_KEYS = [
  "C♯",
  "D♭",
  "D♯",
  "E♭",
  "F♯",
  "G♭",
  "G♯",
  "A♭",
  "A♯",
  "B♭",
] as const;

export const VALID_SONG_KEYS: ReadonlySet<string> = new Set([
  ...ASCII_SONG_KEYS,
  ...UNICODE_SONG_KEYS,
]);

export function isValidSongKey(key: string): boolean {
  return VALID_SONG_KEYS.has(key);
}

// Body for POST /api/songs. Shape only — key-value membership (BR-09) is
// checked in the handler so it can return 422 instead of 400.
export const createSongSchema = z.object({
  title: z.string().trim().min(1).max(200),
  artist: z.string().trim().min(1).max(200).nullish(),
  default_key: z.string().trim().min(1).max(5).nullish(),
  bpm: z.number().int().positive().max(400).nullish(),
  tags: z.array(z.string().trim().min(1).max(50)).nullish(),
});
export type CreateSongInput = z.infer<typeof createSongSchema>;

// Query params for GET /api/songs.
export const songSearchQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
});
export type SongSearchQuery = z.infer<typeof songSearchQuerySchema>;
