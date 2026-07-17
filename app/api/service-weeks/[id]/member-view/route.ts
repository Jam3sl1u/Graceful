import { NextRequest } from "next/server";
import { getMemberWeekView } from "./handler";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return getMemberWeekView(req, id);
}
