import ConflictResolution from "./conflict-resolution";

// Conflict Resolution screen (PRD §13 Screen 7 / issue #50). Renders inside
// AppShell via the (app) layout — no per-page shell needed.
export default async function ConflictResolutionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ConflictResolution conflictId={id} />;
}
