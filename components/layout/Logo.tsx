import styles from "./Logo.module.css";

/** Brand lockup: yellow "G" tile + wordmark. `onDark` for navy surfaces. */
export function Logo({ onDark = false }: { onDark?: boolean }) {
  return (
    <span className={`${styles.logo} ${onDark ? styles.onDark : ""}`}>
      <span className={styles.mark} aria-hidden="true">
        G
      </span>
      Graceful
    </span>
  );
}
