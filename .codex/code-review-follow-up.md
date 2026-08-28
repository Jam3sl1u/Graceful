# Iterative Follow-Up Review Standard

Use this standard for each smaller review cycle after the initial comprehensive branch review and subsequent fixes.

The purpose of a follow-up review is to evaluate the **latest fix iteration** without repeating the entire comprehensive audit. Each pass should verify previously reported findings that were addressed, review the code changed during the latest iteration, inspect the immediate technical blast radius of those changes, and identify any concrete defects or regressions introduced or exposed by the fixes.

This is a **review-only** process. Do not modify files, implement fixes, generate patches, or create an implementation plan.

Follow-up reviews are intended to be repeated as needed:

`comprehensive review → fix → follow-up review → fix → follow-up review → ... → ready to merge`

Each follow-up should be materially smaller and more targeted than the original comprehensive review.

## 1. Establish Iteration Scope

Before reviewing:

* Identify the `REV-###` findings that the latest fix cycle intended to address.
* Identify the files, symbols, tests, configuration, schemas, migrations, contracts, and other code changed during the latest fix cycle.
* If a prior review checkpoint, commit, commit range, or other explicit comparison point is provided, use it to isolate the latest changes.
* If no explicit checkpoint is provided, determine the latest remediation scope from available branch history, prior findings, and the current changes. State any material uncertainty rather than silently assuming an exact boundary.
* Identify the immediate callers, callees, shared abstractions, state, contracts, integrations, and tests that could realistically be affected by those changes.

The primary scope of this review is:

1. Prior findings addressed in the latest iteration.
2. Code changed to address those findings.
3. Directly affected neighboring behavior and integration points.
4. Tests relevant to the changed behavior.
5. New concrete issues discovered within that scope.

Do **not** re-run the full comprehensive branch review by default. Do not inspect unrelated parts of the repository simply to recreate broad coverage already performed by the comprehensive review.

However, expand the review when a changed implementation has a realistic wider blast radius. Scope should follow the code's actual dependencies and behavior, not arbitrary file boundaries.

## 2. Review Prior Findings

For each prior `REV-###` finding addressed by the latest fix cycle:

1. Re-read the original finding and remediation objective.
2. Inspect the actual changes made to resolve it.
3. Determine whether the underlying problem is fully resolved rather than merely hidden, moved, or partially addressed.
4. Check whether important invariants, contracts, or assumptions relied on by surrounding code are still preserved.
5. Inspect relevant callers, callees, shared state, integrations, and data flows where necessary to validate the fix.
6. Check whether the remediation introduced a regression or new defect in the affected area.
7. Review relevant tests and determine whether they meaningfully protect the corrected behavior.
8. Run appropriate tests or validation where available and practical.

Assign each reviewed prior finding exactly one status:

* **Resolved** — the remediation objective is fully satisfied, the underlying cause is addressed, and no material regression was identified in the affected scope.
* **Partially Resolved** — meaningful remediation was implemented, but part of the original issue or required outcome remains unresolved.
* **Not Resolved** — the original issue remains materially present, the remediation is ineffective, or the fix addresses the wrong problem.
* **Unable to Verify** — available code, tests, environment, or context is insufficient to determine whether the finding is resolved.

Do not mark a finding resolved merely because code changed in the expected area or because a new test passes.

## 3. Review the Latest Changes

Independently review the code changed during the latest fix cycle, even when it appears to resolve the original finding correctly.

Focus on the areas most likely to be affected by remediation work:

1. **Functional Correctness** — logic errors, incorrect assumptions, boundary conditions, state errors, invalid sequencing, malformed inputs, async/race behavior, and incorrect failure handling.
2. **Regression Risk** — behavior unintentionally changed for existing callers, users, integrations, shared abstractions, or neighboring code paths.
3. **Error Handling / Resilience** — new failure paths, swallowed errors, missing cleanup, partial failures, unsafe retries/fallbacks, or inconsistent state after failure.
4. **Security / Data Safety** — authorization, trust-boundary, validation, sensitive-data, persistence, concurrency, transaction, idempotency, or data-integrity problems introduced or affected by the changes.
5. **Contracts / Integration Behavior** — broken request/response assumptions, schema mismatches, changed return behavior, incompatible interfaces, or incorrect cross-component assumptions.
6. **Tests** — missing regression coverage, weak assertions, untested changed behavior, edge/error cases, or tests that pass without proving the intended behavior.
7. **Maintainability / Cleanup** — only concrete complexity, duplication, dead code, temporary artifacts, or structural problems introduced by the fix that create meaningful technical risk.

This is a **focused checklist**, not a requirement to re-audit every category across the entire branch. Apply each category to the latest changes and their realistic blast radius.

## 4. Review Standards

* Prioritize correctness, regressions, security, data safety, and behavioral compatibility over style.
* Use code, tests, execution flow, schemas, contracts, configuration, and repository behavior as evidence.
* Inspect enough surrounding code to determine whether a suspected issue is actually applicable.
* Do not invent hypothetical defects merely because a risky pattern could theoretically exist.
* Do not report cosmetic formatting, naming, or stylistic preferences.
* Keep findings atomic and deduplicate shared root causes.
* Prefer validation of root causes over validation of symptoms.
* Treat changes to tests as code that must itself be reviewed for correctness.
* Pay particular attention to fixes that broaden conditionals, add fallback behavior, alter state transitions, change error handling, modify shared abstractions, or change contracts; these frequently create second-order regressions.
* If investigation disproves a suspected issue, do not report it.
* Do not broaden into unrelated code unless evidence shows the remediation affects it.

## 5. Prior Finding Verification Format

For each prior finding reviewed in this iteration, use:

### REV-### — Original finding title

* **Status:** Resolved / Partially Resolved / Not Resolved / Unable to Verify
* **Original remediation objective:** Concise restatement of the required outcome
* **Changes inspected:** Relevant files, symbols, components, tests, or configuration
* **Verification evidence:** Evidence supporting the assigned status
* **Root-cause verification:** Whether the underlying cause was actually addressed
* **Regression check:** Relevant surrounding behavior checked for regressions
* **Test verification:** Tests reviewed or executed and what they demonstrate
* **Remaining concern:** Remaining issue or risk; use `None` when fully resolved with no material concern

Keep resolved findings concise. Give more detail to partially resolved, not resolved, or unable-to-verify findings.

## 6. New Findings

Report any concrete new defect discovered while reviewing the latest changes or their realistic blast radius.

A new finding may include:

* a regression introduced by a fix,
* a new bug in remediation code,
* a previously hidden issue directly exposed by the remediation,
* an incomplete interaction between the fix and surrounding code,
* a missing test that creates meaningful regression risk, or
* another concrete problem within the iteration's review scope.

Do not limit new findings only to defects literally caused by the fix. If a real issue is discovered while following an affected execution path, report it when it is relevant to the changed area.

Continue `REV-###` numbering from the existing review history. Never reuse an ID.

Use this format:

### REV-### — Short descriptive title

* **Severity:** Critical / High / Medium / Low
* **Confidence:** Confirmed / Likely — needs verification
* **Category:** Relevant focused-review category or categories
* **Location:** File(s), symbol/function/component, and relevant code region
* **Finding:** Concise statement of what is wrong
* **Evidence:** Concrete evidence supporting the finding
* **Impact:** Why the issue matters
* **Failure scenario:** A realistic scenario in which it would surface
* **Affected scope:** Relevant users, features, callers, data, integrations, or systems
* **Remediation objective:** The condition that must be true after remediation, stated as an outcome rather than implementation steps

Severity definitions:

* **CRITICAL** — security compromise, data loss/corruption, severe production failure, or another extreme merge-blocking defect.
* **HIGH** — significant functional defect, likely regression, major compatibility failure, or substantial production risk.
* **MEDIUM** — real defect, robustness issue, meaningful test gap, or maintainability problem that should be addressed.
* **LOW** — minor but concrete robustness, cleanup, documentation, or maintainability issue worth addressing.

Do not create a technical fix plan or detailed implementation steps for new findings.

## 7. Test and Validation Expectations

Where appropriate:

* Run the tests most directly related to the latest fixes and affected behavior.
* Review newly added or modified tests for meaningful assertions rather than mere execution coverage.
* Confirm that the original failure scenario is protected where practical.
* Check important edge and error cases directly relevant to the changed behavior.
* Run a reasonably scoped broader test suite when it materially increases confidence that neighboring behavior was not broken.
* Clearly distinguish tests actually executed from tests only inspected.
* Report failing tests, unavailable infrastructure, skipped validation, or environmental limitations that materially reduce confidence.

Do not expand into exhaustive repository-wide testing unless the latest changes have a broad blast radius or the review request explicitly asks for it.

## 8. Final Follow-Up Report

Produce the report using this structure.

### 1. Iteration Summary

Include:

* Prior findings reviewed in this iteration
* Count resolved
* Count partially resolved
* Count not resolved
* Count unable to verify
* Number of new findings discovered
* Primary areas changed by the latest fix cycle
* Whether any unresolved or new finding is merge-blocking
* Material review limitations, if any

### 2. Prior Finding Verification

List each prior `REV-###` finding reviewed in this iteration using the required verification format.

### 3. New Findings

List new `REV-###` findings discovered in this iteration.

If none were found, state:

`No new material findings were discovered within the scope of this follow-up review.`

### 4. Test / Validation Results

Summarize:

* Tests and checks actually run
* Relevant results
* Important tests inspected but not run
* Failures or limitations
* Whether the changed behavior is adequately protected

### 5. Remaining Review State

Summarize only the work that remains before merge:

* Prior findings still partially resolved, not resolved, or unable to verify
* New `REV-###` findings requiring remediation
* Any specific validation that still needs to succeed

Do not create an implementation plan.

### 6. Overall Recommendation

Choose exactly one:

* **Ready to merge**
* **Additional fix/review iteration required**
* **Escalate to comprehensive review**
* **Unable to recommend merge due to verification limitations**

Use **Escalate to comprehensive review** only when the latest fixes materially expanded the branch's scope or architecture, changed high-risk shared behavior, or revealed enough new uncertainty that a targeted follow-up can no longer provide adequate confidence.

## 9. Iteration Completion Criteria

The follow-up review is complete only when:

* Every prior finding addressed in the latest fix cycle has an explicit verification status.
* The latest remediation changes themselves have been reviewed for correctness and regressions.
* The realistic blast radius of those changes has been inspected where needed.
* Relevant tests have been reviewed and run where practical.
* Concrete new defects discovered within scope have been assigned new `REV-###` IDs.
* Remaining unresolved work is clearly identified.
* No unrelated full-branch re-audit was performed without a concrete reason.
* No files were modified as part of the review.

The branch may be considered ready to merge from this review cycle when:

* all in-scope prior findings are resolved,
* no new merge-blocking findings remain,
* relevant validation passes or has an explicitly acceptable limitation, and
* the latest changes do not create a reason to escalate back to a comprehensive review.
