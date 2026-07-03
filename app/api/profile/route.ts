import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { ok, fail, notImplemented } from "@/lib/api/response";
import { ErrorCode } from "@/lib/api/errors";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return fail("Not authenticated", ErrorCode.UNAUTHENTICATED, 401);
  return ok({ userId });
}

export async function PUT(_req: NextRequest) {
  return notImplemented("PUT /api/profile");
}
