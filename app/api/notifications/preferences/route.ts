import { NextRequest } from "next/server";
import { getNotificationPreferences, updateNotificationPreferences } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getNotificationPreferences(req);
}

export async function PUT(req: NextRequest): Promise<Response> {
  return updateNotificationPreferences(req);
}
