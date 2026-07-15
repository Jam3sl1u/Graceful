import { NextRequest } from "next/server";
import { getSetlist, createSetlist } from "./handler";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return getSetlist(req, id);
}

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return createSetlist(req, id);
}
