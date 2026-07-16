import { NextRequest } from "next/server";
import { callback } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return callback(req);
}
