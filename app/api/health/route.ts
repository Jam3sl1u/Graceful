import { NextRequest } from "next/server";
import { ok } from "@/lib/api/response";

// The only real (non-stub) route in this scaffolding pass. Pinged by Better
// Uptime every 3 minutes in production (PRD §19.2) and used by the
// Playwright smoke test to confirm the app is actually serving requests.
export async function GET(_req: NextRequest) {
  return ok({ status: "ok" });
}
