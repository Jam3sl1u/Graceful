import { ok, fail, notImplemented } from "@/lib/api/response";
import { ErrorCode } from "@/lib/api/errors";

describe("lib/api/response", () => {
  it("ok() wraps data in a { data } envelope with a 200 default", async () => {
    const res = ok({ hello: "world" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { hello: "world" } });
  });

  it("fail() wraps an error in a { error, code } envelope", async () => {
    const res = fail("nope", ErrorCode.FORBIDDEN, 403);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "nope", code: "FORBIDDEN" });
  });

  it("notImplemented() returns a 501 with the NOT_IMPLEMENTED code", async () => {
    const res = notImplemented("GET /api/example");
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.code).toBe("NOT_IMPLEMENTED");
    expect(body.error).toContain("GET /api/example");
  });
});
