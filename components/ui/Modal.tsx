"use client";

import { useEffect, useId, useRef } from "react";
import { Icon } from "./Icon";
import styles from "./Modal.module.css";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  /** Visible heading; also the dialog's accessible name. */
  title?: string;
  /** Accessible name when there is no visible `title`. */
  label?: string;
  children: React.ReactNode;
};

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Accessible dialog: labelled, focus moves in on open and back on close, Tab
// is trapped inside, Escape and a backdrop click close it. Renders as a
// centred modal on wide screens and a bottom sheet on phones.
export function Modal({ open, onClose, title, label, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {title ? (
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
        ) : null}
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
        {children}
      </div>
    </div>
  );
}
