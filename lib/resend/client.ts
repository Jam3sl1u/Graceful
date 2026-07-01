import "server-only";

// TODO(Sprint 4 #59): dispatch outbound email via Resend (RESEND_API_KEY).
export async function sendEmail(
  _to: string,
  _template: string,
  _data: Record<string, unknown>,
): Promise<void> {
  throw new Error("sendEmail not implemented — see Sprint 4 #59");
}
