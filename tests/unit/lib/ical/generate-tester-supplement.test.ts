// Tester supplement for #63 (iCal export fallback — pure generator).
//
// The coder's own tests/unit/lib/ical/generate.test.ts already covers the
// happy path, escaping order, null omission, and byte-length folding for
// ASCII content. This file independently probes two things the coder's
// suite does not:
//
//   1. `foldLine` must split on octet boundaries WITHOUT cutting a
//      multi-byte UTF-8 character in half — the spec explicitly calls this
//      out ("Splits on byte boundaries without cutting a multi-byte UTF-8
//      character") but the coder's own tests only exercise ASCII ("x"/"A"
//      repeated), which can never hit that branch.
//   2. Escaping happens on the raw text BEFORE folding is applied, so a
//      folded continuation line can never split an escape sequence (e.g.
//      the two characters "\\n") across a CRLF boundary in a way that
//      corrupts the escape when a strict parser reads it back.

import { generateIcs, foldLine, type IcalEventInput } from "@/lib/ical/generate";

describe("foldLine — multi-byte UTF-8 safety (independent of coder's ASCII-only cases)", () => {
  it("never splits a multi-byte character across a fold boundary", () => {
    // U+1F600 GRINNING FACE is a 4-byte UTF-8 sequence (surrogate pair in
    // UTF-16 JS strings). Repeating it forces fold points to land inside a
    // multi-byte sequence unless foldLine backs off correctly.
    const emoji = "\u{1F600}";
    const longValue = emoji.repeat(30);
    const folded = foldLine(`DESCRIPTION:${longValue}`);
    const physicalLines = folded.split("\r\n");

    expect(physicalLines.length).toBeGreaterThan(1);

    // Every physical line must be valid, round-trippable UTF-8: re-encoding
    // and decoding must not introduce a replacement character (U+FFFD),
    // which is what happens when a multi-byte sequence is torn in half.
    for (const line of physicalLines) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
      expect(line).not.toContain("�");
    }

    // Rejoining (stripping CRLF + leading continuation space) must
    // reconstruct the exact original content line, character for character.
    const rejoined = physicalLines.map((l, i) => (i === 0 ? l : l.slice(1))).join("");
    expect(rejoined).toBe(`DESCRIPTION:${longValue}`);
  });

  it("folds mixed CJK text without corrupting characters", () => {
    // CJK characters are 3-byte UTF-8 sequences — a different boundary case
    // than the 4-byte emoji above.
    const cjk = "青山学院"; // 4 chars, 12 bytes
    const longValue = cjk.repeat(15);
    const folded = foldLine(`SUMMARY:${longValue}`);
    const physicalLines = folded.split("\r\n");

    for (const line of physicalLines) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
      expect(line).not.toContain("�");
    }
    const rejoined = physicalLines.map((l, i) => (i === 0 ? l : l.slice(1))).join("");
    expect(rejoined).toBe(`SUMMARY:${longValue}`);
  });
});

describe("generateIcs — escaping is applied before folding", () => {
  const NOW = new Date("2026-07-01T00:00:00.000Z");
  const baseEvent: IcalEventInput = {
    uid: "escape-fold@graceful.app",
    title: "Escape then fold",
    start: "2026-07-12T09:00:00.000Z",
    end: "2026-07-12T11:00:00.000Z",
    location: null,
    description: null,
  };

  it("produces a DESCRIPTION whose escaped+folded form reconstructs to the escaped original", () => {
    // A long description containing commas, semicolons, backslashes, and
    // embedded newlines — long enough that it must fold, and rich enough
    // that if escaping happened AFTER folding (or was skipped on
    // continuation lines), the reconstructed text would not match.
    const rawDescription =
      "Set list, in order; bring backup cable\\, tune before doors, notes:\nverse 1, chorus; bridge, outro. ".repeat(
        3,
      );

    const ics = generateIcs([{ ...baseEvent, description: rawDescription }], { now: NOW });
    const lines = ics.split("\r\n");

    const descIndex = lines.findIndex((l) => l.startsWith("DESCRIPTION:"));
    expect(descIndex).toBeGreaterThanOrEqual(0);

    // Collect the DESCRIPTION property's physical lines (the folded value
    // plus any continuation lines that follow it).
    const propertyLines = [lines[descIndex]];
    let i = descIndex + 1;
    while (lines[i] !== undefined && lines[i]!.startsWith(" ")) {
      propertyLines.push(lines[i]!.slice(1));
      i++;
    }
    const reconstructed = propertyLines.join("").replace(/^DESCRIPTION:/, "");

    // Rebuild what escapeIcsText should have produced from the raw input,
    // and confirm the folded-and-rejoined output matches it exactly (i.e.
    // escaping happened once, on the whole value, before folding — not
    // per-chunk after folding, which would double-escape or mis-escape at
    // chunk boundaries).
    const expectedEscaped = rawDescription
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n|\r|\n/g, "\\n");

    expect(reconstructed).toBe(expectedEscaped);

    // Every physical line (including continuations) must respect the
    // 75-octet budget. Check the original, unmodified physical lines
    // (descIndex through i - 1), not a reconstruction.
    for (let lineIndex = descIndex; lineIndex < i; lineIndex++) {
      expect(Buffer.byteLength(lines[lineIndex] ?? "", "utf8")).toBeLessThanOrEqual(75);
    }
  });
});
