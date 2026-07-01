import { NextRequest } from "next/server";
import { notImplemented } from "@/lib/api/response";

export async function GET(_req: NextRequest) {
  return notImplemented("GET /api/church-group");
}

export async function PUT(_req: NextRequest) {
  return notImplemented("PUT /api/church-group");
}
