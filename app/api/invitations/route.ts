import { NextRequest } from "next/server";
import { notImplemented } from "@/lib/api/response";
import { createInvitation } from "./handler";

export async function GET(_req: NextRequest) {
  return notImplemented("GET /api/invitations");
}

export async function POST(req: NextRequest): Promise<Response> {
  return createInvitation(req);
}
