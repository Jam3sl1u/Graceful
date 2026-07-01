import styles from "./PublicHeader.module.css";

export function PublicHeader() {
  return (
    <header className={styles.header}>
      <span className={styles.logo}>Graceful</span>
    </header>
  );
}
