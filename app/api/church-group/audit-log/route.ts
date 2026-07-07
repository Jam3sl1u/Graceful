import { NextRequest } from "next/server";
import { getAuditLog } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getAuditLog(req);
}
