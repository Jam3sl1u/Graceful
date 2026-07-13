import { NextRequest } from "next/server";
import { deleteAvailability } from "../handler";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> },
): Promise<Response> {
  const { date } = await params;
  return deleteAvailability(req, date);
}
