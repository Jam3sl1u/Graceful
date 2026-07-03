jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { requireAuth, requireRole, type AuthContext, type UserLookup } from "@/lib/api/auth";
import { ApiException } from "@/lib/api/errors";

const mockAuth = auth as unknown as jest.Mock;

const fakeReq = {} as NextRequest;

const authCtx: AuthContext = {
  userId: "user-1",
  churchGroupId: "group-1",
  role: "admin",
};

describe("lib/api/auth", () => {
  beforeEach(() => {
    mockAuth.mockReset();
  });

  describe("requireAuth", () => {
    it("throws 401 UNAUTHENTICATED when Clerk userId is null", async () => {
      mockAuth.mockResolvedValue({ userId: null });
      const lookup: UserLookup = jest.fn().mockResolvedValue(authCtx);

      await expect(requireAuth(fakeReq, lookup)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        status: 401,
      });
      expect(lookup).not.toHaveBeenCalled();
    });

    it("throws 401 UNAUTHENTICATED when Clerk userId is set but lookup returns null", async () => {
      mockAuth.mockResolvedValue({ userId: "clerk_1" });
      const lookup: UserLookup = jest.fn().mockResolvedValue(null);

      await expect(requireAuth(fakeReq, lookup)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        status: 401,
      });
    });

    it("returns the AuthContext from the injected lookup when Clerk userId is set", async () => {
      mockAuth.mockResolvedValue({ userId: "clerk_1" });
      const lookup: UserLookup = jest.fn().mockResolvedValue(authCtx);

      const ctx = await requireAuth(fakeReq, lookup);
      expect(ctx).toEqual(authCtx);
      expect(lookup).toHaveBeenCalledWith("clerk_1");
    });
  });

  describe("requireRole", () => {
    it("does not throw when ctx.role is in the allowed list", () => {
      expect(() => requireRole(authCtx, ["admin", "set_leader"])).not.toThrow();
    });

    it("throws ApiException FORBIDDEN 403 when ctx.role is not allowed", () => {
      try {
        requireRole({ ...authCtx, role: "member" }, ["admin"]);
        throw new Error("expected requireRole to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiException);
        expect(err).toMatchObject({ code: "FORBIDDEN", status: 403 });
      }
    });
  });
});
