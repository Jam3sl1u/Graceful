import { NextRequest } from "next/server";
import { removeSetlistSong } from "../../handler";

type Ctx = { params: Promise<{ id: string; songId: string }> };

export async function DELETE(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id, songId } = await params;
  return removeSetlistSong(req, id, songId);
}
