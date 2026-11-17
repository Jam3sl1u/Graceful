import styles from "./Badge.module.css";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

type BadgeProps = {
  children: React.ReactNode;
  tone?: BadgeTone;
};

// Status and role labels. Tone is never the only signal — the text always
// says the status.
export function Badge({ children, tone = "neutral" }: BadgeProps) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}
