import { NextRequest } from "next/server";
import { notImplemented } from "@/lib/api/response";

export async function GET(_req: NextRequest) {
  return notImplemented("GET /api/service-weeks/[id]");
}

export async function PUT(_req: NextRequest) {
  return notImplemented("PUT /api/service-weeks/[id]");
}

export async function DELETE(_req: NextRequest) {
  return notImplemented("DELETE /api/service-weeks/[id]");
}
