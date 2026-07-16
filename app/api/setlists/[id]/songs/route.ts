import { NextRequest } from "next/server";
import { addSetlistSong } from "../handler";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return addSetlistSong(req, id);
}
