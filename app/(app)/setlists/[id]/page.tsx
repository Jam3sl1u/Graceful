import SetlistBuilder from "./setlist-builder";

// PRD wireframe screen 5 — Set Leader Setlist Builder (#64). Mirrors
// app/(app)/week/[id]/page.tsx: server wrapper that awaits `params` and
// renders a "use client" child.
export default async function SetlistBuilderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SetlistBuilder setlistId={id} />;
}
