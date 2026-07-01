# .pipeline/ — agent handoff folder

This folder is the shared workspace where the four pipeline agents drop their
output for the next agent to read. Files are produced in order:

| File               | Written by | Read by            | Contents                                   |
| ------------------ | ---------- | ------------------ | ------------------------------------------ |
| `spec.md`          | Planner    | Coder              | Implementation spec + OPEN QUESTIONS       |
| `changes.md`       | Coder      | Tester             | Summary of what changed and where          |
| `test-results.md`  | Tester     | Reviewer           | Pass/fail report                           |
| `review.md`        | Reviewer   | You (human)        | Verdict: SHIP / NEEDS WORK / BLOCK         |

Run the pipeline with:

    /feature <your feature request>

Each run overwrites the files above. The artifacts from the last run stay here
until the next one, so you can always inspect what each agent decided.
