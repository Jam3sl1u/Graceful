import { PublicHeader } from "@/components/layout/PublicHeader";

// Shared chrome for the signed-out entry screens (/invite, /join, /guest):
// people arrive here from a text or email, so the brand has to be visible.
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PublicHeader />
      {children}
    </>
  );
}
