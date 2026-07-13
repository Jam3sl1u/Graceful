import { NextRequest } from "next/server";
import { cancelServiceWeek } from "../handler";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return cancelServiceWeek(req, id);
}
