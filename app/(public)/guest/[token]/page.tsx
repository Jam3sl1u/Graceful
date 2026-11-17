import { auth } from "@clerk/nextjs/server";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Page } from "@/components/ui/Page";
import GuestClaimForm from "./guest-claim-form";
import styles from "../../public-entry.module.css";

// Guest account-setup screen (#72). A brand-new guest's invitation email
// (once #68 sends it) links here instead of straight to /invite/:token,
// because a guest needs a real Clerk account before their placeholder
// `users` row can be claimed. Mirrors app/(public)/join/[code]/page.tsx.
export default async function GuestClaimPage({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<React.ReactElement> {
  const { token } = await params;
  const { userId } = await auth();

  if (!userId) {
    const redirectPath = `/guest/${token}`;
    return (
      <Page width="narrow">
        <Card className={styles.card}>
          <span className={styles.eyebrow}>Guest invitation</span>
          <h1>Create your account</h1>
          <p className={styles.lead}>
            You need an account before you can finish setting up this invitation.
          </p>
          <ButtonLink
            href={`/sign-up?redirect_url=${encodeURIComponent(redirectPath)}`}
            variant="accent"
            size="lg"
            fullWidth
          >
            Sign up
          </ButtonLink>
          <p className={styles.alt}>
            Already have an account?{" "}
            <a href={`/sign-in?redirect_url=${encodeURIComponent(redirectPath)}`}>Sign in</a>
          </p>
        </Card>
      </Page>
    );
  }

  return <GuestClaimForm token={token} />;
}
