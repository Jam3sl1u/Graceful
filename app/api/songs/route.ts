import { NextRequest } from "next/server";
import { listSongs, createSong } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return listSongs(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return createSong(req);
}
