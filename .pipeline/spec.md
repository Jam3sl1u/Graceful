# Spec: Issue #11 — [Sprint 0] Initialize Next.js project & tooling

## OPEN QUESTIONS

None. The gap is concrete and unambiguous — proceed as specified below.

---

## 1. Summary

Issue #11 is **~90% already satisfied** by pre-existing code committed to
`main`. A full Next.js App Router + TypeScript codebase already exists. Three of
the four acceptance criteria are already met. The Coder's job is small and
**purely additive** — do NOT re-scaffold, do NOT touch dependencies, do NOT
touch the `app/` route structure, config strictness, or auth.

Acceptance criteria status (verified against current checkout):

| AC | Status |
|----|--------|
| Next.js (App Router) + TypeScript initialized | DONE — no action |
| ESLint + Prettier configured AND passing on clean checkout | **PARTIAL — Prettier gap, this is the work** |
| Base folder structure documented | **MISSING — this is the work** |
| `bun run dev` works with no errors | DONE — no action |

Scope of this issue = **(a) make Prettier actually pass on a clean checkout**
and **(b) document the folder structure in the README.** Nothing else.

---

## 2. Verified current state (do not redo this work)

- `package.json`: `next@^15.3.0`, `react@^19`, `react-dom@^19`,
  `typescript@^5.7.0`, `prettier@^3.4.0`, `eslint@^9`, `eslint-config-next`.
  Scripts present: `dev`, `build`, `start`, `lint` (`eslint .`),
  `typecheck` (`tsc --noEmit`), `test`, `test:e2e`.
  **No `format` or `format:check` script exists.**
- App Router only. Route groups `app/(app)/`, `app/(auth)/`,
  `app/(marketing)/`, `app/(public)/`, plus `app/api/*` handlers and root
  `app/layout.tsx` + `app/globals.css`. No `pages/` directory anywhere.
- `tsconfig.json`: strict, `noUncheckedIndexedAccess`, `@/*` path alias, Next
  plugin. Excludes `node_modules`, `song2score`, `.pipeline`, `documentation`.
- `next.config.ts`: minimal (`reactStrictMode`, `outputFileTracingRoot`,
  scoped `eslint.dirs`). Do not change.
- `eslint.config.mjs`: flat config extending `next/core-web-vitals` +
  `next/typescript`; `ignores: ["song2score/**", ".pipeline/**",
  "documentation/**", ".next/**", "next-env.d.ts"]`; one relaxed rule
  (`no-unused-vars` warn with `^_` ignore). Leave as-is.
- `.prettierrc` exists:
  `{ "semi": true, "singleQuote": false, "trailingComma": "all", "printWidth": 100 }`.
  Leave the config values as-is.
- `.prettierignore`: **does not exist** — root cause of the failing Prettier AC.
- `README.md`: only 2 lines (title + tagline). No folder-structure docs.
- Top-level source dirs present: `app/`, `components/`, `lib/`, `schemas/`,
  `types/`, `supabase/`, `tests/`.
- `.github/workflows/ci.yml` exists (uses bun). **Out of scope** — do NOT edit
  it (CI is issue #12).

---

## 3. Files to create / modify

### 3.1 CREATE `/Users/jamesliu/Documents/Graceful/.prettierignore`

Purpose: scope `prettier --check .` to source only, so docs/config/generated
files stop false-failing the check. Mirror the dirs already ignored by ESLint
and TS, plus build/vendor output. Exact contents:

```
# Dependencies & build output
node_modules
.next
out
coverage

# Nested project with its own toolchain
song2score

# Pipeline & docs (not developer source; not Prettier's concern)
.pipeline
documentation
.claude

# Lockfiles / generated
bun.lock
package-lock.json
next-env.d.ts
```

Notes for the Coder:
- `README.md` is intentionally NOT ignored — it is real developer-facing
  source and must be Prettier-clean (see 3.3).
- Keep `documentation/` and `.pipeline/` ignored (matches ESLint/TS config and
  avoids reformatting PRD/planning markdown).

### 3.2 MODIFY `/Users/jamesliu/Documents/Graceful/package.json`

Add two scripts to the `"scripts"` block (do not remove or reorder existing
ones). Insert after the existing `"typecheck"` entry:

```json
"format": "prettier --write .",
"format:check": "prettier --check .",
```

Do NOT add or bump any dependency — `prettier@^3.4.0` is already a devDep.

### 3.3 REFORMAT source files that violate the Prettier config

After 3.1 is in place, run `bunx prettier --write .` (or `bun run format`).
This will reformat any tracked source file that violates `printWidth: 100` /
the other rules. Known offenders from prior inspection (long lines Prettier
wraps) — but rely on `prettier --write` to find the authoritative set, do not
hand-edit:
- `app/(auth)/layout.tsx`
- `components/ui/Button.tsx`
- `lib/api/webhook-verify.ts`
- `app/globals.css`
- `README.md` (will be reformatted; see 3.4 for the content you add first)

**Constraint:** every diff produced here MUST be pure formatting
(whitespace / line wrapping / quotes / trailing commas). If `prettier --write`
would change anything that looks like logic, stop — that indicates a config
problem, not expected behavior. There is none expected here.

### 3.4 MODIFY `/Users/jamesliu/Documents/Graceful/README.md`

Add a concise "Project Structure" section documenting the top-level layout.
Keep it minimal per the issue's explicit "avoid over-engineering" instruction —
a short list with one line each, NOT a deep architecture doc. Preserve the
existing title/tagline. Suggested content (adjust wording, keep it brief):

```markdown
# Graceful
Planning Center capabilities with internal ML features

## Getting Started

```bash
bun install
bun run dev
```

Open http://localhost:3000 to view the app.

## Scripts

- `bun run dev` — start the Next.js dev server
- `bun run build` — production build
- `bun run lint` — ESLint
- `bun run typecheck` — TypeScript check (no emit)
- `bun run format` — format all files with Prettier
- `bun run format:check` — verify formatting

## Project Structure

- `app/` — Next.js App Router routes, layouts, and API route handlers (`app/api/*`)
- `components/` — shared React UI components
- `lib/` — server-side clients and integrations (Supabase, Clerk, etc.)
- `schemas/` — Zod validation schemas
- `types/` — shared TypeScript types
- `supabase/` — Supabase project config and migrations
- `tests/` — Jest and Playwright tests
```

Only document dirs that actually exist (all listed above do). Do not invent
subfolders or describe files that don't exist.

---

## 4. Out of scope (do NOT do)

- Do NOT edit `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, or
  `.prettierrc` config values.
- Do NOT add/remove/bump dependencies.
- Do NOT edit `.github/workflows/ci.yml` (CI wiring is issue #12).
- Do NOT touch auth, or add any UI/pages beyond what exists.
- Do NOT change route structure or any `app/api/*` logic.

---

## 5. Verification (all must pass on a clean checkout after changes)

Run from repo root:

1. `bun run format:check` — must pass with zero warnings (was failing before).
2. `bun run lint` — must still pass (already passes today).
3. `bun run typecheck` — must still pass (already passes today).
4. `bun run dev` — must start with no errors; `curl http://localhost:3000/`
   returns HTTP 200.

If `format:check` reports files outside real source (e.g. `documentation/`,
`.pipeline/`, node vendor dirs), the `.prettierignore` in 3.1 is incomplete —
fix the ignore file rather than reformatting those files.
