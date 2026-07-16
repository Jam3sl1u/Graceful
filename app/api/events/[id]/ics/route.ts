import { NextRequest } from "next/server";
import { exportEventIcs } from "./handler";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return exportEventIcs(req, id);
}
