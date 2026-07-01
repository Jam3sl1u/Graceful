import { NextRequest } from "next/server";
import { notImplemented } from "@/lib/api/response";

export async function PATCH(_req: NextRequest) {
  return notImplemented("PATCH /api/church-group/members/[id]/role");
}
