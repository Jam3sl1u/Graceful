import { NextRequest } from "next/server";
import { listDocuments, registerDocument } from "./handler";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return listDocuments(req, id);
}

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return registerDocument(req, id);
}
