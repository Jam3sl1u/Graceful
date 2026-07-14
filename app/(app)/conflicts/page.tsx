import ConflictsList from "./conflicts-list";

// Conflicts list screen (PRD wireframe screen 7 / issue #47/#50). Renders
// inside AppShell via the (app) layout — no per-page shell needed. Links to
// the per-conflict resolution screen at app/(app)/conflicts/[id].
export default function Page() {
  return <ConflictsList />;
}
