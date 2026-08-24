import { NextRequest } from "next/server";
import { createGuestInvitation } from "../handler";

export async function POST(req: NextRequest): Promise<Response> {
  return createGuestInvitation(req);
}
