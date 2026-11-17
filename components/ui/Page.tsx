import styles from "./Page.module.css";

type PageProps = {
  width?: "narrow" | "medium" | "wide";
  children: React.ReactNode;
  className?: string;
};

/** The `<main>` of a screen: consistent max-width, gutters and vertical rhythm. */
export function Page({ width = "medium", children, className }: PageProps) {
  return (
    <main id="main" tabIndex={-1} className={`${styles.page} ${styles[width]} ${className ?? ""}`}>
      {children}
    </main>
  );
}

type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  subtitle?: React.ReactNode;
  /** Badges or buttons shown beside the title. */
  children?: React.ReactNode;
};

export function PageHeader({ eyebrow, title, subtitle, children }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.titles}>
        {eyebrow ? <span className={styles.eyebrow}>{eyebrow}</span> : null}
        <h1>{title}</h1>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </div>
      {children ? <div className={styles.actions}>{children}</div> : null}
    </header>
  );
}
