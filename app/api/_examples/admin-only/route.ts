import { NextRequest } from "next/server";
import { adminOnlyExample } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return adminOnlyExample(req);
}
