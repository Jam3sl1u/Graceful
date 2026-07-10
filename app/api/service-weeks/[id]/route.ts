import { NextRequest } from "next/server";
import { notImplemented } from "@/lib/api/response";
import { getServiceWeek, updateServiceWeek } from "./handler";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return getServiceWeek(req, id);
}

export async function PUT(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return updateServiceWeek(req, id);
}

export async function DELETE(_req: NextRequest) {
  return notImplemented("DELETE /api/service-weeks/[id]"); // #38 — out of scope
}
