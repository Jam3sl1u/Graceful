import { NextRequest } from "next/server";
import { handleResendWebhook } from "./handler";

export async function POST(req: NextRequest): Promise<Response> {
  return handleResendWebhook(req);
}
