"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { Icon } from "./Icon";
import styles from "./Toast.module.css";

type ToastTone = "success" | "error";
type ToastItem = { id: number; message: string; tone: ToastTone };

type ToastApi = { toast: (message: string, tone?: ToastTone) => void };

// Without a provider (unit tests, public pages) toasts are a silent no-op, so
// a toast must only ever *confirm* something the screen already shows — never
// be the only place an error or result appears.
const ToastContext = createContext<ToastApi>({ toast: () => {} });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const TOAST_MS = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const toast = useCallback((message: string, tone: ToastTone = "success") => {
    const id = nextId.current++;
    setItems((prev) => [...prev.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), TOAST_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Always mounted so screen readers register the live region before
          the first message is inserted. */}
      <div className={styles.region} role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`${styles.toast} ${styles[item.tone]}`}>
            <Icon name={item.tone === "success" ? "checkCircle" : "alert"} size={18} />
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
