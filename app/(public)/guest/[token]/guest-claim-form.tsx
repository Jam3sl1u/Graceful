"use client";

import { useState } from "react";

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
      <main style={{ padding: "3rem 1.5rem" }}>
        <h1>You&apos;re all set!</h1>
        <p>Your account has been created.</p>
        <p>
          <a href={`/invite/${token}`}>View your invitation</a>
        </p>
      </main>
    );
  }

  return (
    <main style={{ padding: "3rem 1.5rem" }}>
      <h1>Finish setting up your account</h1>
      <p>Confirm to finish creating your guest account for this invitation.</p>
      <button onClick={handleClaim} disabled={status === "submitting"}>
        {status === "submitting" ? "Setting up…" : "Finish setting up your account"}
      </button>
      {status === "error" && error ? <p role="alert">{error}</p> : null}
    </main>
  );
}
