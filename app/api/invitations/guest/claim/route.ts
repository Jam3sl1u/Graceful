import { NextRequest } from "next/server";
import { claimGuestInvitation } from "../../handler";

export async function POST(req: NextRequest): Promise<Response> {
  return claimGuestInvitation(req);
}
