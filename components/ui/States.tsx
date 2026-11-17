"use client";

import { useEffect, useState } from "react";
import { Button } from "./Button";
import { Icon, type IconName } from "./Icon";
import styles from "./States.module.css";

type Tone = "info" | "danger" | "success" | "warning";

const ICON_TONE: Record<Tone, string> = {
  info: "",
  danger: styles.iconDanger ?? "",
  success: styles.iconSuccess ?? "",
  warning: styles.iconWarning ?? "",
};

type StateBlockProps = {
  icon: IconName;
  tone?: Tone;
  title: string;
  /** Heading level for `title`. Full-page states use 1; states inside a card use "p". */
  titleAs?: "h1" | "h2" | "h3" | "p";
  children?: React.ReactNode;
  actions?: React.ReactNode;
  compact?: boolean;
  role?: "status" | "alert";
};

function StateBlock({
  icon,
  tone = "info",
  title,
  titleAs: Title = "p",
  children,
  actions,
  compact,
  role,
}: StateBlockProps) {
  return (
    <div className={`${styles.state} ${compact ? styles.compact : ""}`} role={role}>
      <span className={`${styles.icon} ${ICON_TONE[tone]}`}>
        <Icon name={icon} size={compact ? 20 : 28} />
      </span>
      <Title className={styles.title}>{title}</Title>
      {children ? <div className={styles.message}>{children}</div> : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}

type EmptyStateProps = Omit<StateBlockProps, "tone" | "role" | "icon"> & { icon?: IconName };

/** "Nothing here yet." Compact by default because it usually sits inside a card. */
export function EmptyState({ icon = "inbox", compact = true, ...props }: EmptyStateProps) {
  return <StateBlock icon={icon} compact={compact} {...props} />;
}

/** A positive terminal state (e.g. "You're on the schedule"). Announced politely. */
export function SuccessState(props: Omit<StateBlockProps, "tone" | "role" | "icon">) {
  return <StateBlock icon="checkCircle" tone="success" role="status" titleAs="h1" {...props} />;
}

/** A neutral terminal state (expired, already answered, not found). */
export function NoticeState({
  icon = "alert",
  tone = "warning",
  ...props
}: Omit<StateBlockProps, "role" | "icon"> & { icon?: IconName }) {
  return <StateBlock icon={icon} tone={tone} titleAs="h1" {...props} />;
}

/** The signed-in user's role does not allow this screen. */
export function NoAccessState({
  title = "You don't have access to this page",
  children,
  actions,
}: {
  title?: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <StateBlock icon="lock" tone="warning" title={title} titleAs="h1" actions={actions}>
      {children}
    </StateBlock>
  );
}

function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

type ErrorStateProps = {
  title?: string;
  children?: React.ReactNode;
  /** Re-run the failed load. When offline, it is also called automatically on reconnect. */
  onRetry?: () => void;
  actions?: React.ReactNode;
  compact?: boolean;
};

/**
 * A load failed. Distinguishes "you're offline" from "our side broke", never
 * blames the user, and always offers a way forward (retry and/or `actions`).
 */
export function ErrorState({
  title = "Something went wrong",
  children,
  onRetry,
  actions,
  compact,
}: ErrorStateProps) {
  const online = useOnline();
  const wasOffline = useState({ value: false })[0];

  useEffect(() => {
    if (!online) {
      wasOffline.value = true;
    } else if (wasOffline.value) {
      wasOffline.value = false;
      onRetry?.();
    }
  }, [online, onRetry, wasOffline]);

  const retry = onRetry ? (
    <Button variant="secondary" onClick={onRetry}>
      <Icon name="refresh" size={18} />
      Try again
    </Button>
  ) : null;

  if (!online) {
    return (
      <StateBlock
        icon="wifiOff"
        tone="warning"
        title="You're offline"
        titleAs={compact ? "p" : "h1"}
        compact={compact}
        role="alert"
        actions={
          <>
            {retry}
            {actions}
          </>
        }
      >
        Check your connection. This page will reload by itself when you&apos;re back online.
      </StateBlock>
    );
  }

  return (
    <StateBlock
      icon="alert"
      tone="danger"
      title={title}
      titleAs={compact ? "p" : "h1"}
      compact={compact}
      role="alert"
      actions={
        retry || actions ? (
          <>
            {retry}
            {actions}
          </>
        ) : undefined
      }
    >
      {children ?? "That's on our side, not yours. Please try again."}
    </StateBlock>
  );
}

/** Inline error for a failed *action* (the screen itself is still usable). */
export function ErrorAlert({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className={styles.alert}>
      <Icon name="alert" size={18} />
      <span>{children}</span>
    </p>
  );
}

type SkeletonProps = { width?: string | number; height?: string | number; radius?: string };

export function Skeleton({ width = "100%", height = "1rem", radius }: SkeletonProps) {
  return (
    <span
      className={styles.skeleton}
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

/**
 * Whole-screen loading placeholder: a heading bar plus `cards` card-shaped
 * blocks, so the layout does not jump when data arrives. Announces "Loading…"
 * once to assistive tech.
 */
export function LoadingState({ cards = 2, label = "Loading…" }: { cards?: number; label?: string }) {
  return (
    <div className={styles.skeletonStack} role="status">
      <span className="sr-only">{label}</span>
      <Skeleton width="55%" height="2rem" />
      <Skeleton width="35%" />
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className={styles.skeletonCard} aria-hidden="true">
          <Skeleton width="40%" height="1.25rem" />
          <Skeleton />
          <Skeleton width="80%" />
          <Skeleton width="60%" />
        </div>
      ))}
    </div>
  );
}
