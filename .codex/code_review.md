# Comprehensive Branch Review Standard

Use this standard whenever conducting a comprehensive review of a feature or implementation branch.

The purpose of the review is to identify concrete defects, regressions, risks, and meaningful maintainability problems and produce an evidence-based report suitable for a separate technical-planning pass.

This is a **review-only** process. Do not modify files, write fixes, generate patches, or produce an implementation plan while performing the review.

If the review request separately provides a PRD, specification, acceptance criteria, issue, or other requirements source, use that material as additional review context. Requirements validation is optional and should only be performed when such context is explicitly supplied.

## 1. Establish Review Scope

Before evaluating findings:

* Determine the intended base branch and compare the complete branch against it.
* If the review request explicitly names the base branch, use it.
* If the base branch cannot be confidently determined, state the assumption or limitation in the report rather than silently guessing.
* Identify the major systems, components, APIs, schemas, migrations, configuration, dependencies, and tests affected by the branch.
* Identify the observable behavior introduced, removed, or changed by the branch from the code, tests, interfaces, and surrounding implementation.

Do not restrict analysis to the diff alone. Inspect relevant surrounding code, callers, callees, shared abstractions, dependencies, tests, schemas, configuration, and repository conventions whenever necessary to determine whether a potential issue is real.

## 2. Review Checklist

Treat the following categories as a mandatory checklist. Work through **every category** before concluding the review.

A category may have no findings, but it must not be skipped. Do not stop the review after discovering significant issues; continue until all categories have been evaluated.

1. **Functional Correctness** — logic errors, invalid assumptions, boundary conditions, malformed or unexpected inputs, state bugs, async/race issues, incorrect sequencing, incorrect calculations or transformations, and incorrect failure behavior.
2. **Regressions / Compatibility** — unintended changes to existing behavior, shared systems, callers, utilities, components, APIs, schemas, data models, integrations, or backward compatibility.
3. **Error Handling / Resilience** — swallowed errors, overly broad handling, missing validation, missing cleanup, poor propagation, unsafe retries/fallbacks, partial failure handling, and states left inconsistent after failure.
4. **Security / Trust Boundaries** — authentication, authorization, permissions, input handling, injection risks, secrets, sensitive data exposure, unsafe trust assumptions, and stack-relevant vulnerabilities.
5. **Data Integrity / Persistence** — transactions, migrations, constraints, concurrency, idempotency, duplication, corruption, data loss, partial writes, stale state, and unsafe schema or data changes.
6. **API / Integration Contracts** — request and response formats, validation, status/error behavior, compatibility, frontend/backend assumptions, external-service assumptions, versioning, and breaking contract changes.
7. **Performance / Resource Usage** — N+1 queries, unnecessary requests/renders, repeated work, inefficient algorithms, poor scaling behavior, excessive memory/CPU use, resource leaks, blocking operations, and avoidable expensive work.
8. **Code Quality / Maintainability** — unnecessary complexity, duplication, confusing control flow, dead code, inappropriate abstractions, fragile logic, hidden coupling, and concrete future-maintenance risk. Do not report purely stylistic preferences.
9. **Architecture / Repository Conventions** — separation of concerns, ownership boundaries, dependency direction, coupling, reuse of existing abstractions, consistency with established repository patterns, and architectural inconsistencies introduced by the branch.
10. **Tests / Verification** — missing coverage, weak assertions, untested changed behavior, edge/error/regression gaps, brittle tests, false-confidence tests, and tests that do not actually prove intended behavior.
11. **Cleanup / Implementation Artifacts** — debugging code, console logs, TODOs, hardcoded development values, mock data, obsolete flags, commented-out code, temporary workarounds, generated files, accidental artifacts, or unrelated changes.
12. **Documentation / Configuration / Dependencies** — environment variables, dependency changes, configuration, setup requirements, deployment implications, migrations, operational assumptions, and documentation made missing or stale by the branch.
13. **Cross-System / End-to-End Behavior** — interactions between changed components, data flow across boundaries, lifecycle behavior, sequencing across layers, shared-state assumptions, and failures that only emerge when individually correct pieces interact.

If requirements or acceptance criteria were explicitly supplied with the review request, additionally verify the branch against them and report any concrete omissions or mismatches. This supplemental check does not replace any of the 13 mandatory categories above.

## 3. Review Standards

* Prioritize correctness, production risk, regression risk, security, and data safety over style.
* Do not invent hypothetical issues simply because a pattern could theoretically be dangerous.
* Before reporting a finding, inspect enough surrounding code, relevant call sites, tests, and execution flow to establish that the issue is applicable.
* Prefer evidence from actual code paths, tests, schemas, contracts, configuration, and repository behavior.
* Keep findings atomic: one distinct underlying problem per finding.
* Avoid duplicates. If one root cause affects multiple locations, report the root cause once and describe its affected scope unless the locations require materially different remediation.
* Clearly distinguish confirmed defects from issues that still require verification.
* Report maintainability concerns only when they create concrete technical risk or materially increase future change cost.
* Do not report cosmetic formatting, naming, or stylistic preferences unless they conceal a correctness or maintainability problem.
* Consider interactions between changed files and systems, not only isolated local correctness.
* Check whether changed code preserves important invariants and assumptions relied on by existing callers and neighboring systems.
* If evidence disproves an initially suspected issue, do not include it as a finding.

## 4. Severity Levels

Assign every finding exactly one severity:

* **CRITICAL** — security compromise, data loss/corruption, severe production failure, or another merge-blocking defect with extreme impact.
* **HIGH** — significant functional defect, likely regression, major compatibility failure, or substantial production risk.
* **MEDIUM** — real defect, robustness issue, meaningful test gap, or maintainability problem that should be addressed but is unlikely to cause catastrophic failure.
* **LOW** — minor but concrete robustness, cleanup, documentation, or maintainability issue worth addressing.

Severity should reflect realistic impact and likelihood, not how difficult the fix appears to be.

## 5. Required Finding Format

Assign every finding a stable ID in sequence: `REV-001`, `REV-002`, `REV-003`, etc.

Use this format for every finding:

### REV-### — Short descriptive title

* **Severity:** Critical / High / Medium / Low
* **Confidence:** Confirmed / Likely — needs verification / Improvement
* **Category:** One or more review checklist categories
* **Location:** File(s), symbol/function/component, and relevant lines or code region
* **Finding:** Concise statement of what is wrong, missing, or risky
* **Evidence:** Specific code, behavior, test, schema, contract, configuration, or call-flow evidence supporting the finding
* **Impact:** Why the issue matters technically or to users/system behavior
* **Failure scenario:** A realistic scenario in which the issue would surface
* **Affected scope:** Features, callers, data, users, integrations, or systems potentially affected
* **Remediation objective:** The condition that must be true after remediation, expressed as an outcome rather than implementation steps
* **Verification notes:** Assumptions, uncertainties, or additional checks the later planning/fix pass should resolve

When an external requirements source was explicitly supplied and is relevant to a finding, add:

* **Requirements reference:** Relevant requirement, acceptance criterion, issue, or specification section

Do **not** include detailed implementation steps, proposed patches, exact file-by-file modifications, or a technical execution plan inside findings. The review should establish **what is wrong and what outcome is required**, while a later planning pass determines **how to implement the fix**.

## 6. Final Review Report

Produce the report using the following structure.

### 1. Executive Summary

Include:

* Overall branch quality
* Primary risk areas
* Count of Critical / High / Medium / Low findings
* Whether any findings are merge-blocking
* Any material review limitations or assumptions

### 2. Findings

List every finding using the required `REV-###` format.

Order findings by:

1. Severity
2. Expected impact within the same severity

### 3. Testing Assessment

Summarize:

* Important changed behavior adequately covered by tests
* Missing or inadequate coverage
* Edge/error/regression scenarios not protected
* Tests that provide false confidence or do not adequately verify behavior

Reference related `REV-###` findings where applicable rather than duplicating them.

### 4. Requirements Assessment — Only If Provided

Include this section only when the review request explicitly supplied a PRD, specification, acceptance criteria, issue, or other requirements source.

Summarize:

* Requirements verified as implemented correctly
* Requirements that appear incomplete, incorrect, or inconsistent
* Requirements that could not be confidently verified
* Required flows or acceptance criteria that remain unsupported

Reference related `REV-###` findings where applicable rather than duplicating them.

### 5. Review Coverage Checklist

Explicitly account for all 13 mandatory review categories.

For each category state either:

* **Reviewed — findings:** `REV-###`, `REV-###`, etc.
* **Reviewed — no material findings**

No category may be omitted.

### 6. Planning Inputs

Provide a concise handoff for the later technical-planning pass containing only:

* `REV-###` findings requiring action
* Dependencies or ordering constraints between findings
* Findings that appear to share a common root cause
* Important affected systems or boundaries the planner should consider together
* Open verification questions that must be resolved before or during planning

Do **not** turn this section into an implementation plan.

### 7. Overall Assessment

Choose exactly one:

* **Ready to merge**
* **Ready after minor fixes**
* **Needs another substantial review/fix cycle**
* **Not ready to merge**

Briefly justify the assessment using the reported findings and overall branch risk.

## 7. Completion Criteria

The review is complete only when:

* The full branch has been considered relative to the intended base branch.
* All 13 mandatory review categories have been evaluated.
* Relevant surrounding code and call sites have been inspected where needed to validate findings.
* Cross-system interactions and changed behavior have been considered where applicable.
* Findings are evidence-based, deduplicated, and assigned stable `REV-###` IDs.
* Any explicitly supplied requirements context has been evaluated without making requirements documentation a prerequisite for the review.
* The report contains enough technical context for a separate planning pass to create an implementation plan without having to rediscover the underlying problems.
* No files have been modified as part of the review.
