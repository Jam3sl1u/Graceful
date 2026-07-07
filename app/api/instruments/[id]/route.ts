import { NextRequest } from "next/server";
import { deleteInstrument } from "../handler";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return deleteInstrument(req, id);
}
