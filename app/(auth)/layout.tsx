import { PublicHeader } from "@/components/layout/PublicHeader";
import styles from "./auth.module.css";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PublicHeader />
      <main id="main" className={styles.wrap}>
        {children}
      </main>
    </>
  );
}
