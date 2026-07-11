import { NextRequest } from "next/server";
import { getServiceWeek, updateServiceWeek, deleteServiceWeek } from "./handler";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return getServiceWeek(req, id);
}

export async function PUT(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return updateServiceWeek(req, id);
}

export async function DELETE(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return deleteServiceWeek(req, id);
}
