import { NextRequest } from "next/server";
import { disconnect } from "./handler";

export async function DELETE(req: NextRequest): Promise<Response> {
  return disconnect(req);
}
