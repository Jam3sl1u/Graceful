import { NextRequest } from "next/server";
import { withdrawInvitation, getOwnInvitation } from "../handler";

type Ctx = { params: Promise<{ id: string }> };

// GET — in-app member view of their own invitation (#73). See
// getOwnInvitation for auth/scoping.
export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return getOwnInvitation(req, id);
}

export async function DELETE(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return withdrawInvitation(req, id);
}
