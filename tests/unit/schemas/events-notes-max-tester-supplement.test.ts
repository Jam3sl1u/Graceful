// Tester-stage supplemental coverage for issue #77 Change 2: the new
// .max(2000) cap on createEventSchema.notes / updateEventSchema.notes.
// Independent of the Coder's tests/unit/schemas/events.test.ts.

import { createEventSchema, updateEventSchema } from "@/schemas/events";

const validCreateBody = {
  serviceWeekId: "11111111-1111-1111-1111-111111111111",
  type: "rehearsal",
  name: "Full band rehearsal",
  location: "Main hall",
  startTime: "2026-07-12T09:00:00.000Z",
  endTime: "2026-07-12T11:00:00.000Z",
  notes: "Bring in-ears",
};

describe("createEventSchema.notes max length (issue #77)", () => {
  it("accepts notes at exactly the 2000-char boundary", () => {
    const result = createEventSchema.safeParse({
      ...validCreateBody,
      notes: "n".repeat(2000),
    });
    expect(result.success).toBe(true);
  });

  it("rejects notes one character past the 2000-char boundary", () => {
    const result = createEventSchema.safeParse({
      ...validCreateBody,
      notes: "n".repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a multi-megabyte notes body (the unbounded-input case this issue closes)", () => {
    const result = createEventSchema.safeParse({
      ...validCreateBody,
      notes: "n".repeat(2_000_000),
    });
    expect(result.success).toBe(false);
  });

  it("still accepts notes omitted (nullish, unchanged)", () => {
    const { notes: _notes, ...rest } = validCreateBody;
    expect(createEventSchema.safeParse(rest).success).toBe(true);
  });

  it("still accepts notes explicitly null (nullish, unchanged)", () => {
    expect(createEventSchema.safeParse({ ...validCreateBody, notes: null }).success).toBe(true);
  });
});

describe("updateEventSchema.notes max length (issue #77)", () => {
  it("accepts notes at exactly the 2000-char boundary", () => {
    const result = updateEventSchema.safeParse({ notes: "n".repeat(2000) });
    expect(result.success).toBe(true);
  });

  it("rejects notes one character past the 2000-char boundary", () => {
    const result = updateEventSchema.safeParse({ notes: "n".repeat(2001) });
    expect(result.success).toBe(false);
  });
});
