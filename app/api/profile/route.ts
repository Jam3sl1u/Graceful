import { NextRequest } from "next/server";
import { getProfile, updateProfile } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getProfile(req);
}

export async function PUT(req: NextRequest): Promise<Response> {
  return updateProfile(req);
}
