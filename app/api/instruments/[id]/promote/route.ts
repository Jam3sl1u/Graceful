import { NextRequest } from "next/server";
import { promoteInstrument } from "../../handler";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return promoteInstrument(req, id);
}
