import { NextRequest } from "next/server";
import { removeAttendee } from "../handler";

type Ctx = { params: Promise<{ id: string; userId: string }> };

export async function DELETE(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id, userId } = await params;
  return removeAttendee(req, id, userId);
}
