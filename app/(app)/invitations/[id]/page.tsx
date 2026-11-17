import InvitationResponse from "./invitation-response";

// In-app Invitation Response screen (PRD Screen 3 / issue #73). Renders
// inside AppShell via the (app) layout — no per-page shell needed. Lets an
// authenticated member view and accept/deny their own invitation without
// the public response_token (companion to the token-gated
// app/(public)/invite/[token] screen). Reached from the Notification Inbox
// (issue #73) via resolveNotificationHref's "invitation" case.
export default async function InvitationResponsePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <InvitationResponse invitationId={id} />;
}
