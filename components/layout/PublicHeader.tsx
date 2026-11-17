import Link from "next/link";
import { Logo } from "./Logo";
import styles from "./PublicHeader.module.css";

type PublicHeaderProps = {
  /** Shown on the right, e.g. a "Sign in" link on the marketing page. */
  children?: React.ReactNode;
};

export function PublicHeader({ children }: PublicHeaderProps) {
  return (
    <header className={styles.header}>
      <Link href="/" className={styles.logo} aria-label="Graceful home">
        <Logo onDark />
      </Link>
      {children}
    </header>
  );
}
