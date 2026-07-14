import { NextRequest } from "next/server";
import { resolveConflict } from "@/app/api/conflicts/handler";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return resolveConflict(req, id);
}
