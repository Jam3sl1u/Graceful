import { NextRequest } from "next/server";
import { markNotificationRead } from "@/app/api/notifications/handler";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return markNotificationRead(req, id);
}
