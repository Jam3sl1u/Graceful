// Tests for lib/api/postgrest.ts (escapePostgrestFilterValue), added by the
// Testing stage for issue #77. Pure function — no mocks needed.

import { escapePostgrestFilterValue } from "@/lib/api/postgrest";

describe("escapePostgrestFilterValue", () => {
  it("returns a plain alphanumeric string unchanged", () => {
    expect(escapePostgrestFilterValue("amaz")).toBe("amaz");
  });

  it("escapes a double quote so it cannot close the quoted filter term early", () => {
    expect(escapePostgrestFilterValue('amaz"ing')).toBe('amaz\\"ing');
  });

  it("escapes a backslash", () => {
    expect(escapePostgrestFilterValue("amaz\\ing")).toBe("amaz\\\\ing");
  });

  it("escapes backslashes before quotes so a trailing backslash cannot swallow the closing quote", () => {
    // Input ends with \" — naive quote-first-then-backslash escaping would
    // turn this into \\" (an escaped backslash followed by an unescaped
    // quote), which breaks out of the filter term. Escaping backslash first
    // must produce \\\" instead.
    expect(escapePostgrestFilterValue('amaz\\"')).toBe('amaz\\\\\\"');
  });

  it("does not touch reserved PostgREST grammar characters other than backslash/quote", () => {
    // These are exactly the characters the spec says a hostile q could use to
    // break out of the .or(...) filter grammar if left unescaped; once the
    // value is wrapped in double quotes by the caller, PostgREST does not
    // treat them as special, so escapePostgrestFilterValue must leave them
    // alone.
    const value = "a,b(c)d.e";
    expect(escapePostgrestFilterValue(value)).toBe(value);
  });

  it("leaves wildcard characters (%, *) untouched", () => {
    expect(escapePostgrestFilterValue("%amaz*ing%")).toBe("%amaz*ing%");
  });

  it("returns an empty string unchanged", () => {
    expect(escapePostgrestFilterValue("")).toBe("");
  });

  it("escapes multiple quotes and backslashes in the same value", () => {
    expect(escapePostgrestFilterValue('a"b\\c"d')).toBe('a\\"b\\\\c\\"d');
  });
});
