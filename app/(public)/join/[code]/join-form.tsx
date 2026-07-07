"use client";

import { useState } from "react";

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
      <main style={{ padding: "3rem 1.5rem" }}>
        <h1>You&apos;re in!</h1>
        <p>You have joined the church group.</p>
      </main>
    );
  }

  return (
    <main style={{ padding: "3rem 1.5rem" }}>
      <h1>Join church group</h1>
      <p>Invite code: {code}</p>
      <button onClick={handleJoin} disabled={status === "submitting"}>
        {status === "submitting" ? "Joining…" : "Join group"}
      </button>
      {status === "error" && error ? <p role="alert">{error}</p> : null}
    </main>
  );
}
