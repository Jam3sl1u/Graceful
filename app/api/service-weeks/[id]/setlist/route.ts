import { NextRequest } from "next/server";
import { notImplemented } from "@/lib/api/response";

export async function GET(_req: NextRequest) {
  return notImplemented("GET /api/service-weeks/[id]/setlist");
}

export async function POST(_req: NextRequest) {
  return notImplemented("POST /api/service-weeks/[id]/setlist");
}
