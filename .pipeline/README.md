# .pipeline/ — agent handoff folder

See `AGENTS.md` at the repo root for the full pipeline contract (what each
stage reads/writes) and policy. This folder is where the artifacts it
describes (`spec.md`, `changes.md`, `test-results.md`, `review.md`) land,
overwritten each run — the artifacts from the last run stay here until the
next one, so you can always inspect what each stage decided.

Run the pipeline with:

    /feature <issue number>
    /handle-issues <issue numbers...>
