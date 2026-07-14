import { NextRequest } from "next/server";
import { createInvitation, listInvitations } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return listInvitations(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return createInvitation(req);
}
