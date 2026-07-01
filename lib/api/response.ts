import "server-only";
import { NextResponse } from "next/server";
import type { ApiError, ApiSuccess } from "@/types/api";
import { ErrorCode } from "@/lib/api/errors";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json<ApiSuccess<T>>({ data }, { status });
}

export function fail(error: string, code: ErrorCode, status: number) {
  return NextResponse.json<ApiError>({ error, code }, { status });
}

// Placeholder response for scaffolded-but-unimplemented routes (Sprint 1+).
// Returns 501 so it's unambiguous in tests/monitoring that this is a stub,
// not a real "not found" or "forbidden".
export function notImplemented(label: string) {
  return fail(`${label} is not implemented yet`, ErrorCode.NOT_IMPLEMENTED, 501);
}
