import "server-only";

// TODO(Sprint 3 #52): build the Google OAuth consent URL
// (GOOGLE_CLIENT_ID/GOOGLE_REDIRECT_URI), write-only calendar.events scope.
export function getAuthUrl(_churchGroupId: string): string {
  throw new Error("getAuthUrl not implemented — see Sprint 3 #52");
}

// TODO(Sprint 3 #52): exchange the OAuth code for tokens
// (GOOGLE_CLIENT_SECRET), encrypt via lib/google-calendar/token-crypto.ts
// before persisting to google_calendar_tokens.
export async function exchangeCode(_code: string): Promise<never> {
  throw new Error("exchangeCode not implemented — see Sprint 3 #52");
}
