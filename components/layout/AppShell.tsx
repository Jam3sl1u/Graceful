import { NotificationBell } from "./NotificationBell";
import styles from "./AppShell.module.css";

// TODO(Sprint 1+): real nav (dashboard, week view, setlists, profile) once
// church-group + role data is wired up — notifications is now wired up
// (#73).
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>Graceful</div>
        <nav className={styles.nav}>
          <NotificationBell />
        </nav>
      </aside>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
