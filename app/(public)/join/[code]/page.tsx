import JoinForm from "./join-form";

// Invite-code join screen. POSTs to /api/church-group/join (issue #25).
export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <JoinForm code={code} />;
}
