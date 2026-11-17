"use client";

import { useState } from "react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Page } from "@/components/ui/Page";
import { ErrorAlert, SuccessState } from "@/components/ui/States";
import styles from "../../public-entry.module.css";

// Invite-code join form (issue #25). POSTs to /api/church-group/join.
//
// Per human resolution on issue #25's OPEN QUESTION #2: the join endpoint
// returns the new membership record in the 201 response body, and this page
// does NOT redirect to a profile-completion page — that redirect is a
// separate follow-up tracked against issue #16.
export default function JoinForm({ code }: { code: string }) {
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleJoin() {
    setStatus("submitting");
    setError(null);

    try {
      const res = await fetch("/api/church-group/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteCode: code }),
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
          title="You're in!"
          actions={
            <ButtonLink href="/notifications" variant="primary">
              Open Graceful
            </ButtonLink>
          }
        >
          You have joined the church group.
        </SuccessState>
      </Page>
    );
  }

  return (
    <Page width="narrow">
      <Card className={styles.card}>
        <span className={styles.eyebrow}>You&apos;ve been invited</span>
        <h1>Join church group</h1>
        <p className={styles.lead}>
          Joining lets your leaders schedule you and share setlists with you.
        </p>
        <p className={styles.code}>
          Invite code: <strong>{code}</strong>
        </p>
        {status === "error" && error ? <ErrorAlert>{error}</ErrorAlert> : null}
        <Button
          variant="accent"
          size="lg"
          fullWidth
          onClick={handleJoin}
          disabled={status === "submitting"}
          loading={status === "submitting"}
        >
          {status === "submitting" ? "Joining…" : "Join group"}
        </Button>
      </Card>
    </Page>
  );
}
