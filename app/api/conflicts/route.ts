import { NextRequest } from "next/server";
import { getOpenConflicts } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getOpenConflicts(req);
}
