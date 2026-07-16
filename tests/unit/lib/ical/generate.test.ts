import {
  generateIcs,
  formatIcsDate,
  escapeIcsText,
  foldLine,
  icsFilename,
  type IcalEventInput,
} from "@/lib/ical/generate";

describe("formatIcsDate", () => {
  it("converts to UTC basic format", () => {
    expect(formatIcsDate(new Date("2026-07-12T09:00:00.000Z"))).toBe("20260712T090000Z");
  });

  it("normalizes an offset date to UTC (no local-time drift)", () => {
    // 2026-07-12T09:00:00-05:00 === 2026-07-12T14:00:00Z
    expect(formatIcsDate(new Date("2026-07-12T09:00:00-05:00"))).toBe("20260712T140000Z");
  });
});

describe("escapeIcsText", () => {
  it("escapes backslash, semicolon, comma, and newlines in that order", () => {
    expect(escapeIcsText("a\\b;c,d")).toBe("a\\\\b\\;c\\,d");
  });

  it("escapes CRLF, CR-only, and LF-only as \\n", () => {
    expect(escapeIcsText("line1\r\nline2")).toBe("line1\\nline2");
    expect(escapeIcsText("line1\rline2")).toBe("line1\\nline2");
    expect(escapeIcsText("line1\nline2")).toBe("line1\\nline2");
  });

  it("does not double-escape a literal backslash introduced by escaping", () => {
    // ";" alone would become "\;" — make sure the backslash from THAT escape
    // isn't itself escaped again (order: backslash first, then the rest).
    expect(escapeIcsText(";")).toBe("\\;");
  });
});

describe("foldLine", () => {
  it("returns short lines unchanged", () => {
    expect(foldLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("folds a line over 75 octets, continuation starting with a single space", () => {
    const longValue = "x".repeat(120);
    const folded = foldLine(`DESCRIPTION:${longValue}`);
    const physicalLines = folded.split("\r\n");

    expect(physicalLines.length).toBeGreaterThan(1);
    for (const line of physicalLines) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    for (const line of physicalLines.slice(1)) {
      expect(line.startsWith(" ")).toBe(true);
    }
    // Rejoining (stripping the CRLF + leading space) reconstructs the
    // original content line.
    expect(physicalLines.map((l, i) => (i === 0 ? l : l.slice(1))).join("")).toBe(
      `DESCRIPTION:${longValue}`,
    );
  });
});

describe("generateIcs", () => {
  const NOW = new Date("2026-07-01T00:00:00.000Z");

  const baseEvent: IcalEventInput = {
    uid: "event-1@graceful.app",
    title: "Full band rehearsal",
    start: "2026-07-12T09:00:00.000Z",
    end: "2026-07-12T11:00:00.000Z",
    location: "Main hall",
    description: "Bring in-ears",
  };

  it("produces a valid VCALENDAR wrapper with CRLF endings and a trailing CRLF", () => {
    const ics = generateIcs([baseEvent], { now: NOW });

    // Every line ending must be CRLF — no bare LF, no bare CR.
    expect(/\r\n/.test(ics)).toBe(true);
    expect(/(?<!\r)\n/.test(ics)).toBe(false);
    expect(/\r(?!\n)/.test(ics)).toBe(false);
    expect(ics.endsWith("\r\n")).toBe(true);

    const lines = ics.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("PRODID:-//Graceful//Graceful//EN");
    expect(lines).toContain("CALSCALE:GREGORIAN");
    expect(lines).toContain("METHOD:PUBLISH");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("emits one VEVENT per event with correct DTSTART/DTEND/DTSTAMP", () => {
    const ics = generateIcs([baseEvent], { now: NOW });

    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:event-1@graceful.app");
    expect(ics).toContain(`DTSTAMP:${formatIcsDate(NOW)}`);
    expect(ics).toContain("DTSTART:20260712T090000Z");
    expect(ics).toContain("DTEND:20260712T110000Z");
    expect(ics).toContain("SUMMARY:Full band rehearsal");
    expect(ics).toContain("LOCATION:Main hall");
    expect(ics).toContain("DESCRIPTION:Bring in-ears");
    expect(ics).toContain("END:VEVENT");
  });

  it("defaults DTSTAMP to the current time when `now` is not injected", () => {
    const before = Date.now();
    const ics = generateIcs([baseEvent]);
    const after = Date.now();

    const match = ics.match(/DTSTAMP:(\d{8}T\d{6}Z)/);
    expect(match).not.toBeNull();
    const raw = match?.[1] ?? "";
    const dtstampMs = new Date(
      `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(
        11,
        13,
      )}:${raw.slice(13, 15)}Z`,
    ).getTime();
    // DTSTAMP is truncated to whole seconds, so allow up to 1s of slack
    // either side of the [before, after] window measured in milliseconds.
    expect(dtstampMs).toBeGreaterThanOrEqual(before - 1000);
    expect(dtstampMs).toBeLessThanOrEqual(after + 1000);
  });

  it("escapes commas, semicolons, backslashes, and newlines in title/description", () => {
    const ics = generateIcs(
      [
        {
          ...baseEvent,
          title: "Rehearsal, take 2; final\\draft",
          description: "line1\nline2",
        },
      ],
      { now: NOW },
    );

    expect(ics).toContain("SUMMARY:Rehearsal\\, take 2\\; final\\\\draft");
    expect(ics).toContain("DESCRIPTION:line1\\nline2");
  });

  it("omits the LOCATION line when location is null", () => {
    const ics = generateIcs([{ ...baseEvent, location: null }], { now: NOW });
    expect(ics).not.toContain("LOCATION:");
  });

  it("omits the LOCATION line when location is an empty/whitespace string", () => {
    const ics = generateIcs([{ ...baseEvent, location: "   " }], { now: NOW });
    expect(ics).not.toContain("LOCATION:");
  });

  it("omits the DESCRIPTION line when notes is null", () => {
    const ics = generateIcs([{ ...baseEvent, description: null }], { now: NOW });
    expect(ics).not.toContain("DESCRIPTION:");
  });

  it("folds a long description across multiple physical lines <= 75 octets", () => {
    const longDescription = "A".repeat(200);
    const ics = generateIcs([{ ...baseEvent, description: longDescription }], { now: NOW });

    const lines = ics.split("\r\n");
    const descriptionLineIndex = lines.findIndex((l) => l.startsWith("DESCRIPTION:"));
    expect(descriptionLineIndex).toBeGreaterThanOrEqual(0);

    // Continuation lines (starting with a single space) directly follow.
    let i = descriptionLineIndex;
    let sawContinuation = false;
    let next = lines[i + 1];
    while (next !== undefined && next.startsWith(" ")) {
      sawContinuation = true;
      expect(Buffer.byteLength(next, "utf8")).toBeLessThanOrEqual(75);
      i++;
      next = lines[i + 1];
    }
    expect(sawContinuation).toBe(true);
    expect(Buffer.byteLength(lines[descriptionLineIndex] ?? "", "utf8")).toBeLessThanOrEqual(75);
  });

  it("supports multiple events, one VEVENT block each", () => {
    const ics = generateIcs(
      [
        baseEvent,
        { ...baseEvent, uid: "event-2@graceful.app", title: "Sound check" },
      ],
      { now: NOW },
    );

    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(2);
    expect(ics.match(/END:VEVENT/g)?.length).toBe(2);
    expect(ics).toContain("UID:event-1@graceful.app");
    expect(ics).toContain("UID:event-2@graceful.app");
  });
});

describe("icsFilename", () => {
  it("lowercases and replaces non-alphanumeric runs with a single dash", () => {
    expect(icsFilename("Full Band Rehearsal!")).toBe("full-band-rehearsal.ics");
  });

  it("collapses repeated separators and trims leading/trailing dashes", () => {
    expect(icsFilename("  --Sunday Service--  ")).toBe("sunday-service.ics");
  });

  it("falls back to 'event' for an empty/all-symbol name", () => {
    expect(icsFilename("!!!")).toBe("event.ics");
    expect(icsFilename("")).toBe("event.ics");
  });
});
