import { NextRequest } from "next/server";
import { getServiceWeeksOverview } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getServiceWeeksOverview(req);
}
