// Display formatting shared by every screen (previously copy-pasted into six
// components). Presentation only — no business rules live here.

/** "Sunday, November 22, 2026" from a YYYY-MM-DD string, read as a local date. */
export function formatServiceDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** "7:00 PM–9:00 PM" */
export function formatTimeRange(startTime: string, endTime: string): string {
  const start = new Date(startTime).toLocaleTimeString(undefined, TIME);
  const end = new Date(endTime).toLocaleTimeString(undefined, TIME);
  return `${start}–${end}`;
}

/** "Thu, Nov 19" */
export function formatShortDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** "Thu, Nov 19 · 7:00 PM–9:00 PM" */
export function formatEventWhen(startTime: string, endTime: string): string {
  return `${formatShortDay(startTime)} · ${formatTimeRange(startTime, endTime)}`;
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  pre_practice: "Pre-practice",
  rehearsal: "Rehearsal",
  sound_check: "Sound check",
  service: "Service",
};

/** Human label for an event-type enum value ("sound_check" → "Sound check"). */
export function formatEventType(type: string): string {
  return EVENT_TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}

/** "182 KB", "1.4 MB" */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
