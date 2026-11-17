"use client";

import { useState } from "react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Page } from "@/components/ui/Page";
import { ErrorAlert, SuccessState } from "@/components/ui/States";
import styles from "../../public-entry.module.css";

// Guest account-claim form (#72). POSTs to /api/invitations/guest/claim.
// Copied almost verbatim from app/(public)/join/[code]/join-form.tsx (same
// status state machine, same inline `style` approach, same `role="alert"`
// error paragraph).
export default function GuestClaimForm({ token }: { token: string }): React.ReactElement {
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleClaim() {
    setStatus("submitting");
    setError(null);

    try {
      const res = await fetch("/api/invitations/guest/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responseToken: token }),
      });
      const body = await res.json();

      if (res.ok) {
        setStatus("success");
      } else {
        setError(body?.error ?? "Something went wrong. Please try again.");
        setStatus("error");
      }
    } catch {
      setError("Something went wrong. Please try again.");
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <Page width="narrow">
        <SuccessState
          title="You're all set!"
          actions={
            <ButtonLink href={`/invite/${token}`} variant="accent">
              View your invitation
            </ButtonLink>
          }
        >
          Your account has been created.
        </SuccessState>
      </Page>
    );
  }

  return (
    <Page width="narrow">
      <Card className={styles.card}>
        <span className={styles.eyebrow}>Guest invitation</span>
        <h1>Finish setting up your account</h1>
        <p className={styles.lead}>
          Confirm to finish creating your guest account for this invitation.
        </p>
        {status === "error" && error ? <ErrorAlert>{error}</ErrorAlert> : null}
        <Button
          variant="accent"
          size="lg"
          fullWidth
          onClick={handleClaim}
          disabled={status === "submitting"}
          loading={status === "submitting"}
        >
          {status === "submitting" ? "Setting up…" : "Finish setting up your account"}
        </Button>
      </Card>
    </Page>
  );
}
