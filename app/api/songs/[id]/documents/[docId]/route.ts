import { NextRequest } from "next/server";
import { deleteDocument } from "../handler";

type Ctx = { params: Promise<{ id: string; docId: string }> };

export async function DELETE(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id, docId } = await params;
  return deleteDocument(req, id, docId);
}
