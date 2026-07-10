import { NextRequest } from "next/server";
import { deleteMember } from "./handler";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return deleteMember(req, id);
}
