import { NextRequest } from "next/server";
import { patchMemberRole } from "./handler";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return patchMemberRole(req, id);
}
