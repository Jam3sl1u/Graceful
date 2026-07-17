import { NextRequest } from "next/server";
import { exportEventsIcs } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return exportEventsIcs(req);
}
