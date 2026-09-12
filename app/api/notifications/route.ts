import { NextRequest } from "next/server";
import { listNotifications } from "@/app/api/notifications/handler";

export async function GET(req: NextRequest): Promise<Response> {
  return listNotifications(req);
}
