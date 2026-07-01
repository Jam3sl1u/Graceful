import styles from "./AppShell.module.css";

// TODO(Sprint 1+): real nav (dashboard, week view, setlists, notifications,
// profile) once church-group + role data is wired up.
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>Graceful</aside>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
