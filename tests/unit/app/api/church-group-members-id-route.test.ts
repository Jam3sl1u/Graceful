// DELETE /api/church-group/members/:id is issue #28 (Remove/archive member),
// still a stub (returns 501). This test only pins the current stub behavior.
// Replace with the full auth matrix (admin success / member->403 / unauth->401
// / malformed->400) once #28 is implemented.

import type { NextRequest } from "next/server";
import { DELETE } from "@/app/api/church-group/members/[id]/route";

describe("DELETE /api/church-group/members/[id] (stub, #28)", () => {
  it("returns 501 NOT_IMPLEMENTED", async () => {
    const res = await DELETE({} as unknown as NextRequest);
    expect(res.status).toBe(501);

    const body = await res.json();
    expect(body.code).toBe("NOT_IMPLEMENTED");
  });
});
