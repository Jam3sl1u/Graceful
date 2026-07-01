import { NextRequest } from "next/server";
import { notImplemented } from "@/lib/api/response";

export async function PUT(_req: NextRequest) {
  return notImplemented("PUT /api/setlists/[id]");
}
