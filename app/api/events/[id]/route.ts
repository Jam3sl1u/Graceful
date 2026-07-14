import { NextRequest } from "next/server";
import { updateEvent, deleteEvent } from "./handler";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return updateEvent(req, id);
}
export async function DELETE(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return deleteEvent(req, id);
}
