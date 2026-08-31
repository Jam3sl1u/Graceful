import { NextRequest } from "next/server";
import { markAllNotificationsRead } from "@/app/api/notifications/handler";

export async function POST(req: NextRequest): Promise<Response> {
  return markAllNotificationsRead(req);
}
