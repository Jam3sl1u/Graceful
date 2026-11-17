"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import { ToastProvider } from "@/components/ui/Toast";
import { Logo } from "./Logo";
import { NotificationBell } from "./NotificationBell";
import styles from "./AppShell.module.css";

type NavItem = { href: string; label: string; icon: IconName; match: string[] };

// Links every signed-in role can open today. Hiding leader-only entries for
// members needs the current user's role on the client, which no endpoint
// exposes yet (documentation/frontend-audit.md, "Needs human decision" #1).
const NAV: NavItem[] = [
  { href: "/dashboard", label: "Schedule", icon: "calendar", match: ["/dashboard", "/week", "/setlists"] },
  { href: "/conflicts", label: "Conflicts", icon: "alert", match: ["/conflicts"] },
];

const PROFILE: NavItem = { href: "/profile", label: "Profile", icon: "user", match: ["/profile"] };

function isActive(pathname: string | null, item: { match: string[] }): boolean {
  if (!pathname) return false;
  return item.match.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// One nav in the DOM: a navy sidebar from 900px up, a bottom tab bar below
// that. Screens render their own <main id="main">, so this shell
// deliberately does not (it used to, producing nested main landmarks).
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const link = (item: NavItem) => {
    const active = isActive(pathname, item);
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          className={`${styles.navLink} ${active ? styles.navLinkActive : ""}`}
          aria-current={active ? "page" : undefined}
        >
          <Icon name={item.icon} size={22} />
          <span>{item.label}</span>
        </Link>
      </li>
    );
  };

  return (
    <ToastProvider>
      <div className={styles.shell}>
        <a href="#main" className={styles.skipLink}>
          Skip to content
        </a>
        <div className={styles.side}>
          <header className={styles.brand}>
            <Link href="/dashboard" className={styles.brandLink} aria-label="Graceful home">
              <Logo onDark />
            </Link>
          </header>
          <nav className={styles.nav} aria-label="Main">
            <ul className={styles.navList}>
              {NAV.map(link)}
              <li>
                <NotificationBell
                  showLabel
                  className={`${styles.navLink} ${
                    isActive(pathname, { match: ["/notifications", "/invitations"] })
                      ? styles.navLinkActive
                      : ""
                  }`}
                />
              </li>
              {link(PROFILE)}
            </ul>
          </nav>
        </div>
        <div className={styles.content}>{children}</div>
      </div>
    </ToastProvider>
  );
}
