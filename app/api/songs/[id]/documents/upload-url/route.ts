import { NextRequest } from "next/server";
import { notImplemented } from "@/lib/api/response";

export async function POST(_req: NextRequest) {
  return notImplemented("POST /api/songs/[id]/documents/upload-url");
}
