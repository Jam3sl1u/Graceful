import { auth } from "@clerk/nextjs/server";
import GuestClaimForm from "./guest-claim-form";

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
      <main style={{ padding: "3rem 1.5rem" }}>
        <h1>Create your account</h1>
        <p>You need an account before you can finish setting up this invitation.</p>
        <p>
          <a href={`/sign-up?redirect_url=${encodeURIComponent(redirectPath)}`}>Sign up</a>
        </p>
        <p>
          Already have an account?{" "}
          <a href={`/sign-in?redirect_url=${encodeURIComponent(redirectPath)}`}>Sign in</a>
        </p>
      </main>
    );
  }

  return <GuestClaimForm token={token} />;
}
