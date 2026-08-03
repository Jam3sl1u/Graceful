import { AppShell } from "@/components/layout/AppShell";
import { InstallPrompt } from "@/components/pwa/InstallPrompt";

// TODO(Sprint 0 #6): wrap with the real role-check once requireAuth/
// requireRole (lib/api/auth.ts) land — this shell doesn't enforce auth yet,
// middleware.ts does that at the request level.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      {children}
      <InstallPrompt />
    </AppShell>
  );
}
