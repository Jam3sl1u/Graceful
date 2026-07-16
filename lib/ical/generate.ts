import { NextResponse } from "next/server";

// Pure RFC 5545 (iCalendar) generator for #63's export-only .ics fallback.
// No `server-only` here — this module has no DB/auth dependency and must
// stay unit-testable without a request context. `icsResponse` below does
// import `next/server`, which is fine outside of route handlers/RSCs.

export type IcalEventInput = {
  uid: string; // globally-unique, stable per event
  title: string; // maps to SUMMARY
  start: string; // ISO 8601 with offset (events.start_time)
  end: string; // ISO 8601 with offset (events.end_time)
  location?: string | null; // omit LOCATION line when null/empty
  description?: string | null; // omit DESCRIPTION line when null/empty
};

// Converts a Date to RFC 5545 UTC "basic" format, e.g.
// 2026-07-12T09:00:00.000Z -> "20260712T090000Z". Stored event times are
// `timestamptz` ISO strings, so anchoring to UTC here avoids any local-time
// drift regardless of the server's timezone.
export function formatIcsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// Escapes TEXT values per RFC 5545 §3.3.11. Order matters: backslashes must
// be escaped first, or the escape characters introduced by the later
// replacements would themselves get re-escaped.
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// Folds a single content line so no physical line exceeds 75 octets, per
// RFC 5545 §3.1. Continuation lines are joined with CRLF + a single leading
// space, and that leading space counts toward the 75-octet budget of the
// continuation line — so continuation chunks are capped at 74 octets while
// the first chunk gets the full 75. Splits on octet (byte) boundaries
// without cutting a multi-byte UTF-8 character in half.
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const chunks: string[] = [];
  let start = 0;
  let isFirstChunk = true;

  while (start < bytes.length) {
    const limit = isFirstChunk ? 75 : 74;
    let end = Math.min(start + limit, bytes.length);

    // Don't split a multi-byte UTF-8 sequence: back off while the next byte
    // is a continuation byte (10xxxxxx).
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) {
      end--;
    }

    chunks.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    isFirstChunk = false;
  }

  return chunks.join("\r\n ");
}

// Serializes one or more events into a single RFC 5545 VCALENDAR string.
// `now` is injectable so DTSTAMP is deterministic in tests.
export function generateIcs(events: IcalEventInput[], opts?: { now?: Date }): string {
  const now = opts?.now ?? new Date();
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Graceful//Graceful//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(foldLine(`UID:${event.uid}`));
    lines.push(foldLine(`DTSTAMP:${formatIcsDate(now)}`));
    lines.push(foldLine(`DTSTART:${formatIcsDate(new Date(event.start))}`));
    lines.push(foldLine(`DTEND:${formatIcsDate(new Date(event.end))}`));
    lines.push(foldLine(`SUMMARY:${escapeIcsText(event.title)}`));

    if (event.location && event.location.trim() !== "") {
      lines.push(foldLine(`LOCATION:${escapeIcsText(event.location)}`));
    }
    if (event.description && event.description.trim() !== "") {
      lines.push(foldLine(`DESCRIPTION:${escapeIcsText(event.description)}`));
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  // CRLF everywhere, including a trailing CRLF after the final line.
  return lines.join("\r\n") + "\r\n";
}

// Builds the text/calendar attachment Response shared by both ics handlers.
export function icsResponse(ics: string, filename: string): Response {
  return new NextResponse(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

// Safe download filename from an event name: lowercase, non-alphanumeric
// runs become a single "-", leading/trailing "-" is trimmed, and an
// empty/all-symbol name falls back to "event".
export function icsFilename(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "event"}.ics`;
}
