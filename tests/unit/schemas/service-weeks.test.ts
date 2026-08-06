// Tester-stage coverage for issue #77 Change 2: the new .max(200) caps on
// createServiceWeekSchema/updateServiceWeekSchema sermonTopic/sermonScripture.
// No dedicated schemas/service-weeks test file existed before this issue.

import { createServiceWeekSchema, updateServiceWeekSchema } from "@/schemas/service-weeks";

const validCreateBody = {
  serviceDate: "2026-07-12",
  title: "Sunday Service",
  sermonTopic: "Grace",
  sermonScripture: "Eph 2:8-9",
  speakerName: "Pastor Kim",
};

describe("createServiceWeekSchema — sermonTopic/sermonScripture max length (issue #77)", () => {
  it("accepts a fully valid body", () => {
    expect(createServiceWeekSchema.safeParse(validCreateBody).success).toBe(true);
  });

  it("accepts sermonTopic at exactly the 200-char boundary", () => {
    const result = createServiceWeekSchema.safeParse({
      ...validCreateBody,
      sermonTopic: "a".repeat(200),
    });
    expect(result.success).toBe(true);
  });

  it("rejects sermonTopic one character past the 200-char boundary", () => {
    const result = createServiceWeekSchema.safeParse({
      ...validCreateBody,
      sermonTopic: "a".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it("accepts sermonScripture at exactly the 200-char boundary", () => {
    const result = createServiceWeekSchema.safeParse({
      ...validCreateBody,
      sermonScripture: "b".repeat(200),
    });
    expect(result.success).toBe(true);
  });

  it("rejects sermonScripture one character past the 200-char boundary", () => {
    const result = createServiceWeekSchema.safeParse({
      ...validCreateBody,
      sermonScripture: "b".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a multi-megabyte sermonTopic (the unbounded-input case this issue closes)", () => {
    const result = createServiceWeekSchema.safeParse({
      ...validCreateBody,
      sermonTopic: "x".repeat(2_000_000),
    });
    expect(result.success).toBe(false);
  });

  it("still rejects an empty sermonTopic (min(1) unchanged)", () => {
    const result = createServiceWeekSchema.safeParse({ ...validCreateBody, sermonTopic: "" });
    expect(result.success).toBe(false);
  });
});

describe("updateServiceWeekSchema — sermonTopic/sermonScripture max length (issue #77)", () => {
  it("accepts sermonTopic at exactly the 200-char boundary", () => {
    const result = updateServiceWeekSchema.safeParse({ sermonTopic: "a".repeat(200) });
    expect(result.success).toBe(true);
  });

  it("rejects sermonTopic one character past the 200-char boundary", () => {
    const result = updateServiceWeekSchema.safeParse({ sermonTopic: "a".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("accepts sermonScripture at exactly the 200-char boundary", () => {
    const result = updateServiceWeekSchema.safeParse({ sermonScripture: "b".repeat(200) });
    expect(result.success).toBe(true);
  });

  it("rejects sermonScripture one character past the 200-char boundary", () => {
    const result = updateServiceWeekSchema.safeParse({ sermonScripture: "b".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("still allows omitting sermonTopic/sermonScripture entirely (optional, unchanged)", () => {
    const result = updateServiceWeekSchema.safeParse({ title: "New title" });
    expect(result.success).toBe(true);
  });
});
