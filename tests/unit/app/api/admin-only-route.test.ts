jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { adminOnlyExample } from "@/app/api/_examples/admin-only/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;

const fakeReq = {} as NextRequest;

function makeLookup(role: UserRole): UserLookup {
  const ctx: AuthContext = {
    userId: "user-1",
    churchGroupId: "group-1",
    role,
  };
  return async () => ctx;
}

describe("GET /api/_examples/admin-only", () => {
  beforeEach(() => {
    mockAuth.mockReset();
  });

  const roleCases: Array<{
    role: UserRole;
    expectedStatus: number;
    expectedCode?: string;
  }> = [
    { role: "admin", expectedStatus: 200 },
    { role: "set_leader", expectedStatus: 403, expectedCode: "FORBIDDEN" },
    { role: "member", expectedStatus: 403, expectedCode: "FORBIDDEN" },
    { role: "guest", expectedStatus: 403, expectedCode: "FORBIDDEN" },
  ];

  it.each(roleCases)(
    "role=$role -> status $expectedStatus",
    async ({ role, expectedStatus, expectedCode }) => {
      mockAuth.mockResolvedValue({ userId: "clerk_test" });

      const res = await adminOnlyExample(fakeReq, makeLookup(role));
      expect(res.status).toBe(expectedStatus);

      const body = await res.json();
      if (expectedStatus === 200) {
        expect(body).toEqual({ data: { ok: true } });
      } else {
        expect(body.code).toBe(expectedCode);
      }
    },
  );

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const lookup = jest.fn();

    const res = await adminOnlyExample(fakeReq, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });
});
