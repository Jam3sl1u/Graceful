import { validateEventTiming, BR10_WINDOW_MS, createEventSchema, updateEventSchema } from "@/schemas/events";

// BR-10 (PRD §8): end must be after start; both endpoints must be within 72h
// (absolute) of the service_date, anchored at 00:00:00 UTC.
describe("validateEventTiming (BR-10)", () => {
  const SERVICE_DATE = "2026-07-12"; // anchor: 2026-07-12T00:00:00.000Z

  it("returns null (valid) for a well-formed same-day event", () => {
    const msg = validateEventTiming(
      SERVICE_DATE,
      "2026-07-12T09:00:00.000Z",
      "2026-07-12T11:00:00.000Z",
    );
    expect(msg).toBeNull();
  });

  it("returns an error when end_time equals start_time (order edge case)", () => {
    const msg = validateEventTiming(
      SERVICE_DATE,
      "2026-07-12T09:00:00.000Z",
      "2026-07-12T09:00:00.000Z",
    );
    expect(msg).not.toBeNull();
  });

  it("returns an error when end_time is before start_time", () => {
    const msg = validateEventTiming(
      SERVICE_DATE,
      "2026-07-12T11:00:00.000Z",
      "2026-07-12T09:00:00.000Z",
    );
    expect(msg).not.toBeNull();
  });

  it("is valid exactly at the +72h boundary (Math.abs(...) > WINDOW, so == is OK)", () => {
    const anchor = new Date(`${SERVICE_DATE}T00:00:00.000Z`).getTime();
    const start = new Date(anchor + BR10_WINDOW_MS - 60 * 60 * 1000).toISOString();
    const end = new Date(anchor + BR10_WINDOW_MS).toISOString();
    const msg = validateEventTiming(SERVICE_DATE, start, end);
    expect(msg).toBeNull();
  });

  it("is invalid one millisecond past the +72h boundary", () => {
    const anchor = new Date(`${SERVICE_DATE}T00:00:00.000Z`).getTime();
    const start = new Date(anchor + BR10_WINDOW_MS - 60 * 60 * 1000).toISOString();
    const end = new Date(anchor + BR10_WINDOW_MS + 1).toISOString();
    const msg = validateEventTiming(SERVICE_DATE, start, end);
    expect(msg).not.toBeNull();
  });

  it("is valid exactly at the -72h boundary", () => {
    const anchor = new Date(`${SERVICE_DATE}T00:00:00.000Z`).getTime();
    const start = new Date(anchor - BR10_WINDOW_MS).toISOString();
    const end = new Date(anchor - BR10_WINDOW_MS + 60 * 60 * 1000).toISOString();
    const msg = validateEventTiming(SERVICE_DATE, start, end);
    expect(msg).toBeNull();
  });

  it("is invalid one millisecond before the -72h boundary", () => {
    const anchor = new Date(`${SERVICE_DATE}T00:00:00.000Z`).getTime();
    const start = new Date(anchor - BR10_WINDOW_MS - 1).toISOString();
    const end = new Date(anchor - BR10_WINDOW_MS + 60 * 60 * 1000).toISOString();
    const msg = validateEventTiming(SERVICE_DATE, start, end);
    expect(msg).not.toBeNull();
  });

  it("is invalid when start is within the window but end is not", () => {
    const anchor = new Date(`${SERVICE_DATE}T00:00:00.000Z`).getTime();
    const start = new Date(anchor).toISOString();
    const end = new Date(anchor + BR10_WINDOW_MS + 60 * 60 * 1000).toISOString();
    const msg = validateEventTiming(SERVICE_DATE, start, end);
    expect(msg).not.toBeNull();
  });
});

describe("createEventSchema", () => {
  const validBody = {
    serviceWeekId: "11111111-1111-1111-1111-111111111111",
    type: "rehearsal",
    name: "Full band rehearsal",
    location: "Main hall",
    startTime: "2026-07-12T09:00:00.000Z",
    endTime: "2026-07-12T11:00:00.000Z",
    notes: "Bring in-ears",
  };

  it("accepts a fully valid body", () => {
    expect(createEventSchema.safeParse(validBody).success).toBe(true);
  });

  it("accepts a body with location/notes omitted (nullish)", () => {
    const { location: _location, notes: _notes, ...rest } = validBody;
    expect(createEventSchema.safeParse(rest).success).toBe(true);
  });

  it("accepts a body with location/notes explicitly null", () => {
    expect(
      createEventSchema.safeParse({ ...validBody, location: null, notes: null }).success,
    ).toBe(true);
  });

  it("rejects a bad type enum value", () => {
    expect(createEventSchema.safeParse({ ...validBody, type: "banquet" }).success).toBe(false);
  });

  it("rejects a missing name", () => {
    const { name: _name, ...rest } = validBody;
    expect(createEventSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a non-uuid serviceWeekId", () => {
    expect(
      createEventSchema.safeParse({ ...validBody, serviceWeekId: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("rejects a non-ISO datetime for startTime", () => {
    expect(
      createEventSchema.safeParse({ ...validBody, startTime: "07/12/2026 9am" }).success,
    ).toBe(false);
  });

  it("rejects a datetime without a UTC offset", () => {
    expect(
      createEventSchema.safeParse({ ...validBody, startTime: "2026-07-12T09:00:00" }).success,
    ).toBe(false);
  });
});

describe("updateEventSchema", () => {
  it("rejects an empty object (at least one field required)", () => {
    expect(updateEventSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a single-field update", () => {
    expect(updateEventSchema.safeParse({ name: "New name" }).success).toBe(true);
  });

  it("accepts explicit null for location to clear it", () => {
    expect(updateEventSchema.safeParse({ location: null }).success).toBe(true);
  });

  it("does not accept serviceWeekId (not part of the update shape)", () => {
    // serviceWeekId isn't a recognized key, but zod's default .object() mode
    // strips unknown keys rather than rejecting them — assert it's absent
    // from the parsed result rather than asserting parse failure.
    const result = updateEventSchema.safeParse({
      name: "New name",
      serviceWeekId: "11111111-1111-1111-1111-111111111111",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("serviceWeekId");
    }
  });
});
