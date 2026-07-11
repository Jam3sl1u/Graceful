import { NextRequest } from "next/server";
import { getTeamAvailability } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getTeamAvailability(req);
}
