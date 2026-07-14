import { NextRequest } from "next/server";
import { listEvents, createEvent } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return listEvents(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return createEvent(req);
}
