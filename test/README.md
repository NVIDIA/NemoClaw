<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Test Directory

The test directory uses execution lanes first and behavior areas second.

## Execution lanes

| Directory | Vitest project | Purpose |
|---|---|---|
| `installer-integration/` | `installer-integration` | Tests that spawn the real installer process |
| `package-contract/` | `package-contract` | Tests that import compiled CLI or plugin artifacts |
| `e2e/support/` | `e2e-support` | Deterministic tests for E2E fixtures and support code |
| `e2e/live/` | `e2e-live` | Opt-in tests that mutate external state |

Other `*.test.js` and `*.test.ts` files outside the dedicated lanes above belong to the `integration` project.
The project globs in `vitest.config.ts` must remain disjoint and exhaustive.

## Shared test code

- Put passive inputs in `fixtures/`.
- Put deterministic reusable utilities in `helpers/`.
- Put stateful harnesses, fake services, and process setup in `support/`.
- Keep one-test companion modules with their owning test when practical.

## Adding tests

Choose the execution lane from the boundary that the test exercises.
Within the integration project, group new tests by the behavior that owns the assertion.
For example, `process-recovery/` owns sandbox process and forward recovery coverage, `channels/` owns channel lifecycle coverage, and `credentials/` owns host credential storage and reset coverage.
Do not put an ordinary integration test in `e2e/` or `package-contract/`.

Run `npm run test:projects:check` after adding or moving a test.

## Regression evidence

Reproduce a defect before fixing it when feasible. If reproduction is not feasible, record why and
preserve the strongest pre-fix evidence. Add regression coverage at the earliest stable behavior
boundary that could detect the defect. Add higher-level coverage only for a distinct integration
boundary. Include negative and state-safety evidence when the acceptance criteria or risk require it.

Rerun affected tests after an edit or hook autofix changes tested behavior.

When a defect escapes normal controls, record the product cause, detection gap, and smallest durable
prevention evidence in the issue or pull request. Search a bounded set of sibling paths for the same
failure class. Fix sibling instances only when they share the cause and fit the current scope.

## Test contracts

Do not read shipped YAML, JSON, manifests, workflows, or E2E runtime files only to assert literal
structure. Use synthetic fixtures for schema tests. Test behavior through the owning consumer or
validator.

A direct source-shape assertion requires a reviewed security or compatibility trust-boundary
exception. Put this annotation immediately above the test:

```ts
// source-shape-contract: security -- Cross-field digest equality protects the shipped trust anchor
```

Use `security` or `compatibility` as the category and state the concrete reason. Add the file, test
title, and category to the reviewed allowlist in `scripts/find-source-shape-tests.mts`.
`npm run source-shape:check` rejects unsupported categories, short or misplaced reasons, missing
allowlist entries, and unused entries.

### Live E2E assertion ratchet

Run `npm run e2e:assertions:scan` to inspect direct assertions and assertions reachable through
live companion modules. Run `npm run e2e:assertions:check` to compare the current suite with
`ci/e2e-assertion-budget.json`.

An E2E assertion reduction must classify each removed assertion as already covered by a lower test,
moved to a lower test, covered by another retained behavior test, or unnecessary because it has no
distinct quality value. Do not move assertions into helpers, aggregate objects, or generated probes.
After a valid reduction, run `npm run e2e:assertions:update` and include the lower baseline in the
same change. The ratchet rejects growth and stale baselines.

Maintainer-approved exceptions can use `changeSha256` in `ci/e2e-assertion-growth-exceptions.json`.
This digest binds every assertion-count and file-inventory change, including reductions, to a PR.
Formatting and unrelated base changes do not invalidate it. Changed deltas, paths, or reference metadata do.
Legacy entries with exact `baseBudgetSha256` and `headBudgetSha256` remain supported and retain their original scope.
Do not convert a legacy approval without maintainer acceptance of the new scope.

The failed growth check prints the change digest. A maintainer can authorize it on the affected PR:

```text
NemoClaw-E2E-Growth: approve <change-sha256>
```

Post the command as the entire comment, without a code fence or explanatory text.
Edited comments are ineligible because moderation can preserve the original author. Post a new record to change a decision.
Inspect the reported budget changes before recording approval.
A request to repair CI does not itself authorize increasing the assertion budget. Use `revoke` instead of `approve` to revoke it.
The independent check reads paginated comments from GitHub and verifies each author's current maintain
or admin role. Bot comments and candidate-defined approvals cannot authorize that check.
The last matching maintainer record wins. Deleting a record removes it from subsequent evaluations.
Creating, editing, or deleting an approval record automatically refreshes the growth check for the current PR commit.
Both PR events and approval changes mark the current commit's required `checks` status pending before running trusted-base checks.
The independent status uses the repository's existing required context. The native CI job produces a check run;
this workflow writes a separate commit status. GitHub requires [both records to pass when their shared name is required](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).
After invalidation, a failed or incomplete check cannot restore the earlier green commit status.
PR and comment evaluations run serially per PR and read current comments instead of replaying old decisions.
Comments quoting the approval marker also trigger reevaluation, but malformed or quoted records are ignored when reading approvals. A quote does not revoke a valid approval. Keeping these events eligible ensures the latest queued evaluation still reads a revocation if GitHub replaces an older pending run in the concurrency group.
No policy PR or manual rerun is required for an approval change.
If cancellation or runner loss prevents the final status report, the pending status continues to block merging. Its Details link identifies the interrupted workflow. After diagnosing the interruption, rerun that workflow under the bounded retry policy; it rereads the current PR and approvals before replacing the status. Ordinary validation failures and cancellations that reach the final reporting step publish failure.
Normal code review and the assertion census still apply. This record authorizes only the stated budget delta.

Local hooks and candidate CI may use the matching branch entry for preliminary validation.
Independent CI accepts trusted-base entries or the GitHub maintainer record, never a candidate's own exception.
Preserve reference metadata and every retained file's budget. Remove branch entries after their PR merges.

New test files must use TypeScript. Each plugin test must execute at least one Vitest `expect`
assertion. The repository test configuration owns automatic mock and environment cleanup; restore
direct global or environment mutations in the test that owns them.

Follow [`WRITING.md`](../WRITING.md) for behavior-oriented test titles. Put a local issue reference
in a final suffix such as `(#1234)`.

## macOS host tools

Some tests require GNU command-line tools that macOS does not provide. The `macos-vitest` job in
[`.github/workflows/platform-vitest-main.yaml`](../.github/workflows/platform-vitest-main.yaml) owns
the authoritative package list. The hosted runner must already provide `gtar`; the workflow verifies
that prerequisite before Homebrew installs the other tools. It then puts the installed GNU binaries
first on `PATH` and exposes `gtar` as `tar` only to the Vitest process through a private shim directory.
This workflow runs only after pushes to `main`; candidate-controlled and manually dispatched code
does not receive its package credential. WSL installs `gnu-coreutils` for fixtures that require GNU
utility behavior, keeps Ubuntu's default utilities intact, and stops Docker before non-live tests.
