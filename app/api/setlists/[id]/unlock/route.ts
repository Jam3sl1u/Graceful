import { NextRequest } from "next/server";
import { notImplemented } from "@/lib/api/response";

export async function POST(_req: NextRequest) {
  return notImplemented("POST /api/setlists/[id]/unlock");
}
