import MemberWeekView from "./member-week-view";

// PRD wireframe screen 3 — Member Week View (#65). Mirrors
// app/(app)/week/[id]/page.tsx: server wrapper that awaits `params` and
// renders a "use client" child.
export default async function MemberWeekViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <MemberWeekView serviceWeekId={id} />;
}
