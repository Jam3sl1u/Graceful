import { NextRequest } from "next/server";
import { listServiceWeeks, createServiceWeek } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return listServiceWeeks(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return createServiceWeek(req);
}
