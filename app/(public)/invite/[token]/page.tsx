import InviteResponse from "./invite-response";

// Token-driven Invitation Response screen (PRD wireframe screen 2). No
// session required — mobile-first, 44x44px minimum touch targets (PRD §14.3,
// A-08). Backed by GET /api/invitations/respond/[token] (Sprint 2 #35, #49).
export default async function InviteResponsePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <InviteResponse token={token} />;
}
