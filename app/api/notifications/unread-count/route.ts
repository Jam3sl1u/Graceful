import { NextRequest } from "next/server";
import { getUnreadNotificationCount } from "@/app/api/notifications/handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getUnreadNotificationCount(req);
}
