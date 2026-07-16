import { NextRequest } from "next/server";
import { reorderSetlist } from "./handler";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return reorderSetlist(req, id);
}
