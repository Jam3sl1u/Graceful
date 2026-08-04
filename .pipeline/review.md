# Review — Issue #68: Integrate Resend email dispatch + webhook verification

VERDICT: SHIP

Reviewed `.pipeline/spec.md`, `.pipeline/changes.md`, `.pipeline/test-results.md`,
the full `git diff main...HEAD`, every changed/added source file, and both the
coder's and the tester's test files. Re-ran `bun run lint`, `bun run typecheck`,
`bun run test` myself from this worktree — all green, 88 suites / 1098 tests,
matching the Testing stage's claim exactly.

## Spec conformance — verified line by line

| Spec item | Status |
| --- | --- |
| `lib/resend/templates.ts` — 7 PRD §30 keys, exact subject/preview copy | matches |
| No trailing period on subjects; em dash (U+2014) preserved in `practice_reminder` | matches |
| `html` string shape (preheader div / h1 / p / optional anchor) | byte-exact vs spec |
| `escapeHtml` applied to subject, preview, and `href`; `text`/returned `subject`/`preview` unescaped | matches (escaping direction is correct, not backwards) |
| `invitation_denied` drops the `Reason: …` clause for `null` and whitespace-only | matches |
| `invitation_reminder_admin` throws on empty `memberNames`; `count` never derived from `.length` | matches |
| Unknown key throws `Unknown email template: …` (untyped-caller guard) | matches |
| No date parsing/formatting; no import of `lib/scheduling/reminder.ts`; no `server-only` | matches |
| `lib/resend/client.ts` lazy singleton mirroring `lib/r2/client.ts` | matches |
| Env guard message, empty-string treated as missing | matches |
| `sendEmail` empty/whitespace `to` throws before env/SDK | matches |
| `{ error }` or null `data` → `Resend email dispatch failed: …` | matches |
| Never logs recipient / subject / body | confirmed — no `console.*` anywhere in `client.ts` |
| `mapResendEventToStatus` — all 7 mappings + `null` default | matches |
| `verifyResendWebhook` — throw on missing secret, `false` on missing headers, `false` on `verify()` throw, ctor throw propagates | matches |
| Other 3 verifier stubs + file header byte-identical | confirmed via diff |
| `handler.ts` order: `req.text()` → verify → `JSON.parse` | correct and load-bearing order preserved |
| 500/401/400 mapping and `ok({received, emailId, status})` | matches |
| Unknown event type → 200 `"ignored"`, never 4xx | matches |
| `route.ts` reduced to a delegation shim exporting only `POST` | matches |
| `.env.example` + `documentation/staging-environment.md` additive-only | confirmed — one line each, nothing else touched |
| No migration, no DB writes, no dependency changes, `bun.lock` untouched | confirmed |
| `middleware.ts`, pingram/clerk/modal routes untouched | confirmed |

Security posture on the webhook path is right: signature verification happens on
the raw body before any parse, a config error (missing secret) surfaces as 500
rather than being mistaken for a bad signature, the response body never echoes
the payload or a recipient, and svix does the constant-time comparison.

## Tests — meaningful, not superficial

- `templates.test.ts` asserts the **entire** `html` string for both the
  with-link and without-link shapes, plus exact subject/preview strings for all
  7 keys. Whitespace or ordering drift would fail. The escaping test uses a real
  `<script>alert("x")</script> & Co` payload and asserts both directions
  (escaped in `html`, unescaped in `subject`/`text`), which is the exact thing
  the changes summary flagged as easy to get backwards.
- `client.test.ts` covers all named cases including the singleton-count case
  and the `data: null, error: null` fallthrough.
- Route test asserts `req.json` is never called and that
  `mapResendEventToStatus` is never reached on a bad signature — real
  order-of-operations coverage, not just status-code checks.
- The Testing stage's 3 supplement files add genuine mutation-resistant cases
  (present-but-empty svix headers, `Webhook` ctor throw propagating,
  non-object/array `data`, empty-string `type`, response body never echoing a
  recipient, singleton genuinely caching). These are the gaps the coder's suite
  actually had; the `-tester-supplement` naming matches 19 existing tracked
  files, so the convention claim checks out.

## Required before opening the PR (orchestration, not a code fix)

The Testing stage's output is **not committed**. `git status` shows:

- ` M .pipeline/test-results.md`
- `?? tests/unit/app/api/webhooks-resend-route-tester-supplement.test.ts`
- `?? tests/unit/lib/api/webhook-verify-resend-tester-supplement.test.ts`
- `?? tests/unit/lib/resend/client-tester-supplement.test.ts`

Only `adfcc26` (the coder's commit) is on this branch. Commit these before the
PR or the branch ships without the independent test coverage and with a stale
`test-results.md` on the remote.

## Non-blocking follow-ups (do not hold this PR)

1. **Non-email Resend events 400 instead of being ignored.**
   `handler.ts` validates `data.email_id` (step 3) *before* mapping the event
   type (step 4), so a `contact.created` / `domain.updated` callback — which has
   no `data.email_id` — returns 400 and triggers exactly the provider retry
   storm the spec cites as the reason unknown *email* events return 200. The
   coder implemented the spec exactly; this is a spec-level gap, and it only
   bites if the operator subscribes this endpoint to non-email event types in
   the Resend dashboard. Suggested follow-up: map the type first and return
   200 `"ignored"` for any type outside `email.*`, keeping the 400 only for
   `email.*` events with a malformed `data`.

2. **`process.env.RESEND_FROM_EMAIL!` re-read at send time**
   (`lib/resend/client.ts:47`). `getClient()` validates it, but only on first
   call; the value is then re-read per send behind a non-null assertion. If the
   variable were ever unset after the singleton is built, `from: undefined` goes
   to the SDK silently. The tester's supplement test deliberately locks this
   behavior in. Practically unreachable in a running server, but capturing
   `fromEmail` alongside the client in `getClient()` would remove both the
   assertion and the hazard.

3. **`export {};` in `tests/unit/lib/resend/client.test.ts`.** The Testing stage
   flagged this correctly: the file has no top-level `import`/`export`
   statement (line 36's `await import(...)` is a dynamic expression), so TS
   treats it as a global script and its `mockSend` / `mockResendCtor` /
   `ENV_KEYS` consts sit in the global scope. It only surfaced because the
   supplement file had to add `export {};` to avoid a `tsc` collision. Runtime
   is unaffected (Jest isolates module registries), but it is a trap for the
   next sibling test file. One-line fix, any time.

4. **No URL-scheme validation on `link`** in `templates.ts`. `escapeHtml`
   correctly prevents attribute breakout, but a `javascript:` or `data:` value
   would still render as an anchor. Links are caller-supplied and internal
   today; worth an allowlist when #69 wires up the real callers.

5. **`console.info` per webhook event** fires on `email.opened` / `email.clicked`
   too, which are high-volume. Consider downgrading those to debug once a
   delivery-log table exists.

None of the above is a correctness, security, or data-integrity defect in the
shipped path. The code does what the spec says, and the spec is a reasonable
reading of the issue.
