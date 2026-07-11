import { NextRequest } from "next/server";
import { getAvailability, setAvailability } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getAvailability(req);
}

export async function PUT(req: NextRequest): Promise<Response> {
  return setAvailability(req);
}
