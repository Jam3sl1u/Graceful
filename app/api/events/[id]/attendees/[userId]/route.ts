import { NextRequest } from "next/server";
import { notImplemented } from "@/lib/api/response";

export async function DELETE(_req: NextRequest) {
  return notImplemented("DELETE /api/events/[id]/attendees/[userId]");
}
