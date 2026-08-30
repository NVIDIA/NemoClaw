<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# PR Review Advisor

The PR Review Advisor is an SDK-powered, NemoClaw-specific pull request reviewer. It runs its
model-backed analysis in OpenShell sandboxes from trusted GitHub Actions jobs and inspects PRs as
read-only data. It posts a sticky comment that links to the complete specialist reviews in the
workflow run.

It complements the existing PR surfaces by keeping a NemoClaw maintainer code-review lens focused on the patch itself and by including E2E coverage and target guidance in the same model session:

- sandbox and workflow security review;
- acceptance coverage for observable outcomes, current constraints and non-goals, supported
  contracts, and explicit maintainer decisions in linked issues. Proposed designs, implementation
  ideas, and ordinary discussion remain context; `Refs #...`, `References #...`, and
  `Follow-up to #...` relations do not make an entire issue binding;
- codebase drift and architecture review grounded in current behavior and contracts;
- source-of-truth review for fallback, recovery, tolerant parsing, monkeypatching, and other localized workaround behavior;
- static test-inventory context from changed test files and nearby test names;
- a complete simplicity sweep that considers the changed code and its surrounding area, including
  safe deletion, consolidation, existing or new patterns, and neutral or negative net-line outcomes.
  Present design defects can block when checked-in evidence shows duplicated ownership, unnecessary
  machinery, substantial repeated setup, widened dependencies, or unrelated churn and the review
  provides a concrete behavior-preserving reduction. The reduction case covers source and tests
  together, defaults to a negative total line outcome, and may be line-neutral only when it
  materially reduces owners, concepts, invalid combinations, or dependency width;
- semantic terminology review for terms that changed explanatory text introduces, expands, or
  redefines, with repository evidence for each model-selected candidate;
- E2E coverage, job, target, and fan-out selections normalized against the checked-in
  deterministic plan and supported inventory;
- correctness and test-quality checks that CI cannot prove.

It intentionally does not report GitHub mergeability, branch protection, CI status, reviewer state, CodeRabbit state, or E2E pass/fail status; those are handled elsewhere in the PR UI.

## Workflow

`.github/workflows/pr-review-advisor.yaml`:

1. Runs on `pull_request_target` for internal and fork PRs, plus trusted manual dispatch.
2. Prepares the target PR as inert analysis data and executes the trusted Advisor entrypoint from the workflow checkout.
3. Runs model analysis inside OpenShell. The sandbox receives neither a GitHub token nor the upstream model credential.
4. Runs one required Pi session for each valid Markdown prompt in `tools/pr-review-advisor/specialists`. Each specialist reads repository evidence and records a native session trace.
5. Each specialist publishes its complete Markdown review as the job summary and uploads the Markdown and native session trace as one artifact.
6. One publisher posts a sticky comment that links to the workflow run after every specialist completes.

`investigate-turn.mts` and `challenge-and-record-turn.mts` own the two normal turn contracts, including their prompts and tool configuration. `trusted-guidance.mts` owns the system prompt and checked-in review guidance. `turn-context.mts` and the context modules build bounded deterministic evidence. `artifacts.mts` owns artifact paths, and `render-result.mts` owns human-readable result output. `analyze.mts` composes these modules and runs the session.

`tools/pr-review-advisor/specialist-lifecycle.mts` owns the advisor-specific prepare, configure,
complete, and cleanup sequence. `tools/pr-review-advisor/openshell.mts` exports its OpenShell
primitives and exposes only sandbox runtime initialization as a CLI command. Both use the shared
lifecycle and credential-boundary helpers in `tools/openshell-agent/runtime.mts`, which are also
used by the merge-conflict fixer.

Provider failures, timeouts, and invalid or missing atomic submission fail closed and leave canonical state unchanged. Failure results retain the reason, and workflow logs retain orchestration diagnostics.

The workflow is advisory and must not be configured as an E2E-required status check. Its comment
links to the specialist reviews and does not dispatch or report pass/fail for E2E jobs.
Model availability must not become the authority
for whether a pull request can merge.
For PRs from this repository, the PR E2E controller separately rebuilds the plan from GitHub's
changed-file list and dispatches every selected job after `CI / Pull Request` completes. `E2E / PR
Gate` does not consume advisor output.

Required-check status is point-in-time context, not a settled-CI gate. Earlier
`PR_REVIEW_ADVISOR_WAIT_*` workflow variables were inert and have been removed; any future waiting
behavior must be implemented and tested before the workflow claims to provide it.

## Author and agent follow-up

Authors and coding agents should follow the shared [PR CI and Review Follow-Up](../../.agents/skills/_shared/pr-follow-up.md) workflow after opening a PR or pushing follow-up commits. If SSH, authentication, remote access, authorization, or permission problems prevent reading comments or pushing fixes, follow [Git and GitHub Access Hard Stop](../../.agents/skills/_shared/git-github-hard-stop.md).

## Safety model

- Static analysis only.
- PR-provided scripts, tests, package lifecycle hooks, and build tools are never executed.
- The model session runs in a digest-pinned OpenShell sandbox under a hard-required Landlock policy with no direct network policy and no ambient workdir. Four canonical host inputs are mounted read-only through the advisor's ephemeral Docker gateway outside `/sandbox`, so OpenShell v0.0.99 applies the final immutable boundary before the first process starts. Landlock independently grants those inputs read-only access. It grants application-data writes only to a bounded runtime tmpfs; required device access remains writable under `/dev`. The sandbox pins Git to `/pr-workdir/.git` and `/pr-workdir` instead of relying on cross-UID repository discovery. A startup proof must read every input canary, resolve the checkout and `HEAD`, fail chmod, overwrite, replacement, and creation in each input, and complete runtime writes. The model-facing Advisor tools remain repository-confined and read-only; generated configuration and artifacts use the dedicated runtime subtree.
- The advisor receives repo-confined read-only repository tools plus deterministic context tools. Repository paths must remain inside the checked-out analysis workspace after lexical and symlink resolution. The record tools replace transaction-local draft sections only; an accepted successful terminal submission atomically commits canonical finding and terminology snapshots; failed validation and rejected terminal flows do not mutate them. None of these tools can change repository or GitHub state.
- PR bodies, comments, titles, branch names, and diffs are treated as untrusted evidence, never as instructions.
- Manual target analysis validates the repository token, decimal PR number, and base-ref token before running any `git` command.
- Generated Pi configuration is written under the sandbox's runtime-only configuration directory, not uploaded artifacts.
- The review job is limited to `NVIDIA/NemoClaw` and has read-only GitHub permissions. Within it, only the trusted host provider-configuration step receives the upstream model secret.
- A separate trusted host step collects deterministic GitHub context with `github.token` and writes a bounded, identity-checked context file before model work. The sandbox receives that file, not the token.
- The OpenShell gateway binds only to loopback and holds the upstream provider credential. The sandbox uses `https://inference.local/v1` with an inert SDK key, and receives neither the provider credential nor a GitHub token.
- The separate publisher has pull-request write permission, but receives neither the model secret, specialist artifacts, nor the untrusted PR worktree. It rechecks the latest PR commit immediately before posting only the workflow-run link.
- Sticky publication updates only a marker-bearing comment owned by `github-actions[bot]`; a user-authored marker cannot claim the update target. Publication errors remain visible in the publisher logs.
- The workflow posts advisory comments only; it does not approve, request changes, merge, push, label, or dispatch E2E.
- The checked-in risk plan is deterministic and additive. PR Review Advisor reviews every listed
  invariant and required job for missing evidence. The trusted E2E normalizer restores any listed
  job that the model omits or downgrades. The PR E2E controller separately dispatches every listed
  job without consuming the advisor's normalized result.

Risk plan version 19 selects the `gateway-topology` family for the production paths in the canonical `GATEWAY_TOPOLOGY_FILES` inventory in `tools/advisors/risk-plan.mts`.

The family requires PR Review Advisor to check this invariant against the diff, sibling consumers,
and checked-in evidence:

> An explicit sandbox-visible host address must be outside the sandbox network subnet, and every
> gateway-address projection must derive from the same authority.

The family does not add an E2E job. Existing topology tests and workflows remain the behavior
authority. Documentation-only and test-only changes do not select the family.

The same risk plan maps runtime changes from these paths to the `focused-e2e` family:

- `src/lib/onboard/managed-startup/**`.
- `src/lib/onboard/sandbox-create-launch.ts`.
- `scripts/lib/entrypoint-env-wrapper.sh`.

Each match selects these focused E2E jobs:

- `device-auth-health`.
- `issue-4462-scope-upgrade-approval`.
- `openclaw-inference-switch`.

The same risk plan maps these Hermes CLI adapter paths to `focused-e2e`:

- `agents/hermes/hermes-cli-adapter-v1.json`.
- `agents/hermes/hermes-wrapper.py`.
- `agents/hermes/validate-cli-adapter.py`.

Each Hermes CLI adapter match selects these focused E2E jobs:

- `channels-stop-start`.
- `mcp-bridge`.

The same risk plan maps these Hermes cron restore paths to `focused-e2e`:

- `agents/hermes/cron-restore-control.py`.
- `agents/hermes/patch-cron-restore-drain.py`.
- `src/lib/actions/sandbox/rebuild-hermes-post-restore.ts`.
- `src/lib/actions/sandbox/runtime/hermes-cron-restore-recovery.ts`.

Each Hermes cron restore match selects `rebuild-hermes`.
The generic `src/commands/sandbox/recover.ts` adapter remains agent-neutral and does not select that job.

## Required secret

Configure this repository secret for review analysis:

- `PR_REVIEW_ADVISOR_API_KEY`

The trusted host uses this secret only to register the OpenAI-compatible
`https://inference-api.nvidia.com/v1` service with OpenShell. The sandboxed analyzer reaches that
provider through `https://inference.local/v1` and does not receive the secret.
The discovered specialists use the workflow-configured model and share the same credential boundary.

If advisor credentials are unavailable, the advisor writes a low-confidence unavailable result
instead of failing closed without artifacts.

## Artifacts

Each specialist artifact contains a Markdown review and Pi's unchanged native JSONL session. The
workflow run also displays each Markdown review as a job summary. Review agents can download an
artifact with `gh run download <run-id> --name pr-review-specialist-<interest>`.

The publisher has the only pull-request write permission. It receives neither the model credential
nor the specialist artifacts. It posts only the workflow-run link.

## Local run

From a prepared contributor checkout, run:

```bash
npm run review:local
```

The command snapshots the committed branch delta from `origin/main`, staged and unstaged final
content, and nonignored untracked files. It runs every checked-in specialist separately through
OpenShell. It writes each specialist's Markdown review and native JSONL session under
`artifacts/pr-review-advisor-local/`. The command does not run tests, inspect CI state, use GitHub
context, or combine findings. Test recommendations are advisory targets verified against the
repository inventory, not executed test results.

Prerequisites:

- Node.js 22.19.0 or newer and npm registry access for the dependencies locked on `origin/main`;
- an `origin/main` remote-tracking commit that contains the trusted local review implementation;
- a running Docker-compatible container runtime. Run `npm run dev:doctor` to verify Docker availability and resources;
- `git`, `openshell`, `openshell-gateway`, `openshell-sandbox`, `rg`, and `fdfind` available on `PATH`;
- `PR_REVIEW_ADVISOR_API_KEY` exported in the host environment for the existing advisor provider.
  The local gateway receives this credential. The sandbox does not receive it. The variable remains
  in the caller environment until you clear it. The command removes the local gateway after the run.

`npm run dev:doctor` checks general contributor readiness. It does not check these local-review
executables, the advisor credential, or the `origin/main` ref.

Running the npm script trusts the contributor checkout's `package.json` entry and built-in-only bootstrap.
After that narrow entry boundary, the executable advisor checkout is detached at the resolved
`origin/main` commit. Other branch changes, including advisor implementation, policy, specialist
prompts, and `node_modules`, exist only in the read-only review snapshot. Before it reads the advisor
credential or starts the implementation, the built-in-only bootstrap runs `npm ci --ignore-scripts
--no-audit --no-fund` in the trusted checkout. npm uses the committed `origin/main` lockfile, normal
cache behavior, and a credential-free environment with user and global npm configuration disabled.
Failure stops the run before the credential-bearing advisor lifecycle starts.

The command attempts to remove its temporary snapshot, trusted dependencies, gateway, and each
sandbox after success, failure, or a handled termination signal. It reports cleanup failures with the
remaining resource name or path. Remove that named resource before retrying.

## Output contract

`tools/pr-review-advisor/schema.json` defines the normalized JSON result shape used by direct local
analysis and future reporting work. Workflow specialists publish Markdown reviews and native session
artifacts instead of a combined normalized result. Findings include probe-shaped fields for impact,
verification hints, and missing regression-test guidance so agents know what to check rather than
treating findings as generic commentary. The required `terminologyReview` field contains the canonical receipt with
each candidate's change type, disposition, meaning, contrast, established alternative, semantic
impact, recommendation, trace ID, and source bound to the head commit. The dispositions are `established`,
`justified`, `define`, `replace`, and `conflict`. The trusted terminology tools are
`pr_review_trace_term` during investigation and `record_review_receipt` during atomic submission.
Trusted tracing verifies repository evidence after the model selects a candidate; it does not scan
or classify changed text to select terms. Every source-of-truth review item includes a `findingId`: unresolved items
reference their covering open ledger finding, while satisfied and not-applicable items use `null`.
Every result also includes nested `e2e.coverage` and `e2e.targets` guidance. The trusted normalizer
restores deterministic requirements before model selections, retains only allowlisted coverage IDs
and supported selector tuples, and replaces model-authored reasons with trusted reasons. It discards
free-form E2E domains, new-test recommendations, and no-selection explanations. For a changed
credential-free test, the normalizer records structured head evidence only after the trusted
module-tag parser accepts the source; model-provided evidence is overwritten. The compatibility
schema retains `requiredTests` and `targets.required`, but those names describe the normalized
advisory tier, not merge requirements. The independent PR E2E controller does not consume advisor
output.
Findings can also include safe simplification metadata with delete, stdlib,
native, YAGNI, or shrink tags; those suggestions must keep validation, security, data-loss prevention,
and required tests intact.
Trusted submission derives `merge_after_fixes` when findings remain and `info_only` for low-confidence
review evidence. A finding-free `superseded` request succeeds only when deterministic context identifies
an open PR that explicitly replaces the PR under review. Without that evidence, `submit_review` rejects
the request and discards pending state. A `superseded` request with findings becomes
`merge_after_fixes`. Other finding-free reviews become `merge_as_is`. Failure output can also use
`info_only`.
These recommendations describe advisor findings only.
They never approve a PR, replace required human review, or change the repository's merge gates.
Warnings identify concerns that maintainers can accept without author action. Suggestions identify
optional improvements. Required design work must be a blocker instead of a warning.
An unnecessary-complexity blocker must remove or consolidate current structure. A helper or
abstraction is eligible only when current consumers adopt it and the combined source-and-test
structure materially decreases. Other recommendations that increase net complexity or merely add a
registry, configuration surface, compatibility layer, fallback, migration path, test framework, or
fixture owner require an independent correctness, security, or accepted-scope defect; they are not
presented as simplification. This keeps architecture feedback strong while preventing review-driven
growth and serial refactoring layers.
Every result includes limitations and requires maintainer review.
