import WeekView from "./week-view";

// PRD wireframe screen 1 — Admin/Set Leader Week View planning workspace
// (#48). Mirrors app/(public)/invite/[token]/page.tsx: server wrapper that
// awaits `params` and renders a "use client" child.
export default async function WeekViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <WeekView serviceWeekId={id} />;
}
