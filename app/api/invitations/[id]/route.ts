import { NextRequest } from "next/server";
import { withdrawInvitation } from "../handler";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return withdrawInvitation(req, id);
}
