# Changes: Issue #11 — [Sprint 0] Initialize Next.js project & tooling

## Summary

Closed the remaining gap on an otherwise-complete Next.js + TypeScript setup:
Prettier now actually passes on a clean checkout, and the README documents the
top-level folder structure. No dependencies, config strictness, routes, or
auth were touched.

## Files changed

- **`.prettierignore`** (new) — scopes Prettier to real developer source.
  Mirrors `eslint.config.mjs`'s ignore list (`song2score/`, `.pipeline/`,
  `documentation/`, `.next/`) plus `node_modules`, `out`, `coverage`,
  `.claude`, and generated/lockfiles (`bun.lock`, `package-lock.json`,
  `next-env.d.ts`). This was the root cause of the failing Prettier
  acceptance criterion — without it, `prettier --check .` was scanning docs
  and pipeline markdown that were never meant to be formatted.

- **`package.json`** — added two bun scripts, inserted right after
  `typecheck` (no reordering/removal of existing scripts, no dependency
  changes):
  - `"format": "prettier --write ."`
  - `"format:check": "prettier --check ."`

- **`app/(auth)/layout.tsx`**, **`components/ui/Button.tsx`**,
  **`lib/api/webhook-verify.ts`**, **`app/globals.css`** — reformatted via
  `bunx prettier --write .` to fix real `printWidth: 100` violations (long
  single-line JSX/function signatures got wrapped; the CSS `font-family`
  list got collapsed to fit under 100 chars). All four diffs are pure
  whitespace/line-wrapping — verified via `git diff` that no logic, strings,
  or identifiers changed. See diffs below for exact deltas.

- **`README.md`** — expanded from a 2-line title/tagline into: Getting
  Started (bun install / bun run dev), a Scripts list (dev/build/lint/
  typecheck/format/format:check), and a new "Project Structure" section
  listing `app/`, `components/`, `lib/`, `schemas/`, `types/`, `supabase/`,
  `tests/` with one line each. Kept intentionally minimal per the issue's
  "don't over-engineer" instruction — no deep architecture doc. This file
  was itself reformatted by Prettier after being written (blank line added
  after the `# Graceful` title).

## Exact diffs for the four reformatted source files

```diff
--- a/app/(auth)/layout.tsx
+++ b/app/(auth)/layout.tsx
@@ -1,3 +1,7 @@
 export default function AuthLayout({ children }: { children: React.ReactNode }) {
-  return <div style={{ display: "flex", justifyContent: "center", padding: "3rem 1rem" }}>{children}</div>;
+  return (
+    <div style={{ display: "flex", justifyContent: "center", padding: "3rem 1rem" }}>
+      {children}
+    </div>
+  );
 }

--- a/app/globals.css
+++ b/app/globals.css
@@ -15,12 +15,7 @@ body {
   margin: 0;
   background: var(--color-bg);
   color: var(--color-fg);
-  font-family:
-    -apple-system,
-    BlinkMacSystemFont,
-    "Segoe UI",
-    Roboto,
-    sans-serif;
+  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
 }

--- a/components/ui/Button.tsx
+++ b/components/ui/Button.tsx
@@ -6,7 +6,5 @@ type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
 };

 export function Button({ variant = "primary", className, ...props }: ButtonProps) {
-  return (
-    <button className={`${styles.button} ${styles[variant]} ${className ?? ""}`} {...props} />
-  );
+  return <button className={`${styles.button} ${styles[variant]} ${className ?? ""}`} {...props} />;
 }

--- a/lib/api/webhook-verify.ts
+++ b/lib/api/webhook-verify.ts
@@ -10,10 +10,7 @@ export async function verifyClerkWebhook(_rawBody: string, _headers: Headers): P
 }

 // TODO(Sprint 4 #58): verify using PINGRAM_WEBHOOK_SECRET.
-export async function verifyPingramWebhook(
-  _rawBody: string,
-  _headers: Headers,
-): Promise<boolean> {
+export async function verifyPingramWebhook(_rawBody: string, _headers: Headers): Promise<boolean> {
   throw new Error("verifyPingramWebhook not implemented — see Sprint 4 #58");
 }
```

## Verification performed (all passed)

1. `bun run format:check` — "All matched files use Prettier code style!"
2. `bun run lint` — passes, no output/errors.
3. `bun run typecheck` — passes, no output/errors.
4. `bun run dev` — started cleanly; `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/` returned `200`. Dev server stopped afterward.

## What the Tester should focus on

- Confirm `bun run format:check` fails if any of the 4 reformatted files (or
  README.md) is reverted to its old formatting — i.e. the check is real, not
  a no-op.
- Confirm `.prettierignore` actually excludes `.pipeline/`, `documentation/`,
  and `song2score/` from `prettier --check .` (these directories contain
  markdown/config that would otherwise false-fail).
- Confirm no logic changed in the 4 reformatted files — behavior of
  `AuthLayout`, `Button`, and the four `verify*Webhook` functions should be
  byte-identical modulo whitespace (diffs above are the full deltas).
- Confirm `eslint.config.mjs`, `tsconfig.json`, `next.config.ts`,
  `.prettierrc`, and `.github/workflows/ci.yml` were NOT touched (out of
  scope per spec section 4).
- `package.json` scripts: verify `format` and `format:check` were inserted
  without disturbing existing scripts (`dev`, `build`, `start`, `lint`,
  `typecheck`, `test`, `test:e2e` all still present, same commands).

## Out of scope (confirmed not touched)

- No dependency changes (prettier@^3.4.0 was already present).
- No changes to `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`,
  `.prettierrc`, `.github/workflows/ci.yml`.
- No route/auth/UI logic changes beyond formatting.
