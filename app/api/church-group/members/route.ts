import { NextRequest } from "next/server";
import { getChurchGroupMembers } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getChurchGroupMembers(req);
}
