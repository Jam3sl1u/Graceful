import type { HTMLAttributes } from "react";
import styles from "./Card.module.css";

type CardProps = HTMLAttributes<HTMLElement> & {
  as?: "div" | "section" | "article" | "li" | "form";
};

export function Card({ as: Tag = "div", className, ...props }: CardProps) {
  return <Tag className={`${styles.card} ${className ?? ""}`} {...(props as object)} />;
}

/** Title row of a card: heading on the left, optional action/badge on the right. */
export function CardHeader({ children }: { children: React.ReactNode }) {
  return <div className={styles.header}>{children}</div>;
}

/** Class names for making a `<Link>` look like a clickable card. */
export const interactiveCardClassName = `${styles.card} ${styles.interactive}`;
