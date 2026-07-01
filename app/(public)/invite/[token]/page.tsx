// Token-driven Invitation Response screen (PRD wireframe screen 2). No
// session required — mobile-first, 44x44px minimum touch targets (PRD §14.3,
// A-08). Backed by GET /api/invitations/respond/[token] (Sprint 2 #35).
export default async function InviteResponsePage({
  params: _params,
}: {
  params: Promise<{ token: string }>;
}) {
  return <h1>Invitation response — coming soon</h1>;
}
