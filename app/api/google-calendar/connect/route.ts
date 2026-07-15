import { NextRequest } from "next/server";
import { connect } from "./handler";

export async function POST(req: NextRequest): Promise<Response> {
  return connect(req);
}
