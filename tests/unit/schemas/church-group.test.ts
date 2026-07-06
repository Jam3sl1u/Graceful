import { createChurchGroupSchema } from "@/schemas/church-group";

describe("createChurchGroupSchema", () => {
  it("happy path — full valid input parses and trims", () => {
    const result = createChurchGroupSchema.safeParse({
      name: "  Grace Church  ",
      timezone: "America/New_York",
      denomination: " Baptist ",
      logo_url: "https://example.com/logo.png",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Grace Church");
      expect(result.data.timezone).toBe("America/New_York");
      expect(result.data.denomination).toBe("Baptist");
      expect(result.data.logo_url).toBe("https://example.com/logo.png");
    }
  });

  it("omitted timezone defaults to America/Chicago", () => {
    const result = createChurchGroupSchema.safeParse({ name: "Grace Church" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timezone).toBe("America/Chicago");
    }
  });

  it("omitted denomination/logo_url are undefined (not required)", () => {
    const result = createChurchGroupSchema.safeParse({ name: "Grace Church" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.denomination).toBeUndefined();
      expect(result.data.logo_url).toBeUndefined();
    }
  });

  it("missing name → validation fails", () => {
    const result = createChurchGroupSchema.safeParse({ timezone: "America/New_York" });
    expect(result.success).toBe(false);
  });

  it("blank/whitespace-only name → validation fails", () => {
    const result = createChurchGroupSchema.safeParse({ name: "   " });
    expect(result.success).toBe(false);
  });

  it("name over 100 chars → validation fails", () => {
    const result = createChurchGroupSchema.safeParse({ name: "a".repeat(101) });
    expect(result.success).toBe(false);
  });

  it("non-IANA timezone string → validation fails", () => {
    const result = createChurchGroupSchema.safeParse({
      name: "Grace Church",
      timezone: "Not/AZone",
    });
    expect(result.success).toBe(false);
  });

  it("logo_url that is not a valid URL → validation fails", () => {
    const result = createChurchGroupSchema.safeParse({
      name: "Grace Church",
      logo_url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("denomination over 100 chars → validation fails", () => {
    const result = createChurchGroupSchema.safeParse({
      name: "Grace Church",
      denomination: "a".repeat(101),
    });
    expect(result.success).toBe(false);
  });
});
