---
name: nemoclaw-maintainer-audit-e2e-assertions
description: "Triage, diagnose, debug, or fix failing or flaky NemoClaw E2E tests. Trace every assertion and downstream gate before a repair push or rerun. Excludes status-only and dispatch-only requests."
license: Apache-2.0
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Audit Every E2E Assertion Before Rerunning

Use the existing suite as the specification for a complete source review. Find the visible failure
and later source-visible failures before the next expensive run. Aim to batch the necessary repairs;
source inspection cannot guarantee runtime success.

The deliverable is an itemized assertion ledger with concrete inputs, producing code, and evidence.
Build the ledger yourself. Do not ask the user to enumerate assertions or supervise its completion.

Follow the shared [writing and review contract](../_shared/documentation-writing-review.md) for the ledger and reports.

## When to Use This Skill

Use this skill whenever investigating a failing or flaky E2E test, including timeouts, setup failures,
assertion failures, and cleanup failures. Apply it when E2E failures emerge during broader PR or CI work,
even when the user does not name this skill. Begin the review before proposing a repair or rerun.

A log classifier can locate evidence, but its summary does not complete the assertion audit.
The E2E execution skill continues to own dispatch and environment authorization.
Status-only queries and requests only to start a run do not require an assertion audit.

## Keep the Requested Boundary

Use the assigned branch and checkout. Preserve the user's restrictions on edits, tests, execution
environments, command visibility, and publication. Reuse established authorization and context.
An audit request alone does not authorize code changes, pushes, live execution, or merges.

Review the requested failing suite and the prerequisites and downstream jobs needed for its stated
completion. Do not turn a scoped repair into repository-wide maintenance or add unrelated checks.
For audit-only work, report proposed corrections without applying them.

## Establish What Actually Failed

Record the candidate commit, run attempt, failing jobs, relevant artifact identities, and requested
completion boundary. Reuse known values; verify identities when evidence might belong to another commit.
Distinguish trusted workflow/controller code from the candidate code and images actually exercised.

Read the complete failed-job logs, including setup, earlier warnings, the failure, teardown, and upload.
Read large logs in sequential chunks. Do not substitute a tail excerpt, search matches, or an automated
summary for the complete log. Retain useful evidence with secrets redacted.
If logs are missing or incomplete, record the gap instead of claiming they were reviewed.

Find the first causal failure. Separate it from later cleanup errors and failures caused by missing
outputs. Mark the last completed assertion and the first unreached assertion.
An unreached assertion has supplied no execution evidence.

## Enumerate the Entire Remaining Contract

Read each in-scope test from setup through final cleanup. Follow its helpers, fixtures, wrappers,
shell scripts, and workflow steps. Continue beyond the currently failing line and the current job.

Assign a stable ID to every assertion and independently meaningful predicate. Include:

- Compound success expressions, helper assertions, exit codes, output parsing, and polling deadlines.
- Scenario variants, matrix inputs, loops, alternate agent/runtime paths, and negative checks.
- Restore, restart, rejection without mutation, destruction, retention, and repeated cleanup.
- Evidence serialization, target completion, artifact upload, and dependent qualification/publication gates.
- Prerequisite gates affected by the proposed diff, including test parity, build inputs, and generated files.

Preserve the user's checklist IDs when provided. Expand combined entries into explicit subitems.
Count predicate rows, not only calls to `expect`. A shared helper requires each distinct caller's
inputs to be checked. Reuse common reasoning with links; do not mark an entire scenario covered by its name.

## Trace Every Predicate Through Its Actual Inputs

For each row, work backward from the expected condition to the code that produces its values.
Then walk forward with the fixture's concrete inputs through the selected branches and state changes.
Record the resulting value or invariant and why it meets the predicate.

Inspect overrides, defaults, legacy/null values, persisted state, environment propagation, and argument
order wherever they affect that result. Check the meaning of an argument as well as its type.
For example, an inference serving port and a gateway state namespace can both be numbers but are not interchangeable.

At an external boundary, inspect the pinned dependency or image version when its behavior controls the assertion.
Do not rely on remembered APIs or the latest upstream implementation for a pinned runtime.
Trace parsing and status propagation back to the actual producer, including stdout/stderr separation.

For lifecycle assertions, record state before and after the operation and the resources owned by each cleanup path.
Follow the state into later assertions: successful creation alone does not establish successful restore or destruction.

For each predicate, identify a concrete way it could be false under those inputs. Check that path.
Resolve contradictions supported by the source; label remaining external conditions precisely.
Do not invent unrelated failure scenarios or broaden the repair into hardening work.

## Maintain the Assertion Ledger

Use one row per predicate and scenario, or linked subrows where needed:

| ID and assertion location | Expected condition | Actual inputs and state | Producing path and reasoning | Correction | Evidence status |
|---|---|---|---|---|---|

Include file/line references and commit or run identities for the evidence. Itemize what you inspected,
what you concluded, and what changed. Entries such as “reviewed,” “same helper,” or “should pass” are insufficient.

Keep source reasoning and runtime evidence separate:

- **Source supported:** the traced inputs and implementation satisfy the predicate under named runtime assumptions.
- **Observed on candidate:** retained execution evidence establishes the predicate for the stated candidate and scenario.
- **Observed previously:** supporting evidence from another commit or scenario; it does not establish a candidate pass.
- **Runtime pending:** name the unavailable observation, such as measured GPU memory, network response, or process exit.
- **Unresolved:** a contradiction, unknown input, or unread code path prevents a supported conclusion.

A row can be source supported and runtime pending. Do not use runtime pending to hide code you have not inspected.
Successful aggregate output proves component predicates only after checking the conjunction and all assignments
and return paths that can produce that output.

## Batch the Supported Repairs

When repairs are authorized, fix the demonstrated cause and other source-supported blockers within the requested boundary.
Attach each change to the ledger rows it resolves. Avoid speculative refactors.

Use the existing assertions for this review. Do not write new regression tests as a substitute for understanding
the remaining path. Honor restrictions on test changes. If a harness input is wrong, explain the mismatch
against the product contract before correcting it within the authorized scope.
Preserve the asserted behavior, thresholds, and deadlines; do not weaken them to obtain a pass.

After edits, inspect every affected caller and ledger row again. Review changed-file prerequisite gates before
publication. Use applicable existing fast checks when permitted; they supplement the source review.
Do not start a live environment or an expensive CI run merely to discover the next source-visible failure.

## Finish the Review Before the Next Push or Run

Before any repair push or expensive rerun, establish all of these conditions:

- Every in-scope assertion and prerequisite has a ledger entry, including unreached paths and cleanup.
- Each entry has concrete inputs, producing code, and a supported conclusion or precisely named runtime dependency.
- No source contradiction, unknown code path, or unreviewed affected caller remains.
- The final diff and applicable prerequisite gates have been checked; every fix maps to evidence.
- Remaining runtime uncertainty and the authorized execution needed to resolve it are stated explicitly.

Do not claim “last assertion” until the remaining helpers, teardown, workflow steps, and dependent jobs
have been accounted for through the user's completion boundary.

If the request is only an audit, deliver the ledger and findings here. If publication and validation are
already authorized, continue without requesting the same permission again. Use the repository E2E execution
workflow only when execution is requested; this skill does not grant additional environment access.

Judge the subsequent run against the completed ledger. A failure requires new causal evidence and an update
to all affected rows before another repair push. Distinguish a missed source obligation from a runtime condition
that inspection could not establish. Do not automatically retry unchanged failures.

Report source-review completion separately from execution success. Declare the requested suite green only
when all required jobs and scenario variants pass for the final candidate. Identify skipped, missing, cancelled,
or older results explicitly. Retain historical evidence as historical when the candidate changes.
