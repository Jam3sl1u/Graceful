import { NextRequest } from "next/server";
import { getInvitationByToken } from "../../handler";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_req: NextRequest, { params }: Ctx): Promise<Response> {
  const { token } = await params;
  return getInvitationByToken(token);
}
