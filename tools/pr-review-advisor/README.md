<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# PR Review Advisor

The PR Review Advisor is an SDK-powered, NemoClaw-specific pull request reviewer. It runs its
model-backed analysis in an OpenShell sandbox from a trusted GitHub Actions job, inspects PRs as
read-only data, and posts a sticky comment with blockers, warnings, and suggestions. Artifacts
retain acceptance coverage, security notes, and other review context.

It complements the existing PR surfaces by keeping a NemoClaw maintainer code-review lens focused on the patch itself and by including E2E coverage and target guidance in the same model session:

- sandbox and workflow security review;
- acceptance coverage for observable outcomes, current constraints and non-goals, supported
  contracts, and explicit maintainer decisions in linked issues. Proposed designs, implementation
  ideas, and ordinary discussion remain context; `Refs #...`, `References #...`, and
  `Follow-up to #...` relations do not make an entire issue binding;
- codebase drift and architecture review grounded in current behavior and contracts;
- source-of-truth review for fallback, recovery, tolerant parsing, monkeypatching, and other localized workaround behavior;
- static test-inventory context from changed test files and nearby test names;
- simplification review for safe delete/stdlib/native/YAGNI/shrink opportunities;
- semantic terminology review for terms that changed explanatory text introduces, expands, or
  redefines, with repository evidence for each model-selected candidate;
- E2E coverage, job, target, and fan-out selections normalized against the checked-in
  deterministic plan and supported inventory;
- correctness and test-quality checks that CI cannot prove.

It intentionally does not report GitHub mergeability, branch protection, CI status, reviewer state, CodeRabbit state, or E2E pass/fail status; those are handled elsewhere in the PR UI.

## Workflow

`.github/workflows/pr-review-advisor.yaml`:

1. Runs on `pull_request_target` for internal and fork PRs, plus `workflow_dispatch`.
2. Checks out advisor implementation code at the immutable trusted `github.workflow_sha` into `advisor/`.
3. Fetches the event's PR base and head SHAs into an isolated analysis workspace without running PR-controlled actions, hooks, submodules, LFS filters, package setup, scripts, or tests.
4. Installs and verifies pinned `ripgrep` and `fd-find` packages on a pinned Ubuntu runner, then installs a pinned Pi SDK package with lifecycle scripts disabled.
5. Materializes deterministic GitHub context on the trusted host before sandbox creation. This is the only analysis-phase step that receives `github.token`, and it receives no model credential.
6. Installs OpenShell, starts a loopback-only gateway, and registers the selected model provider in a dedicated trusted-host step. Only that provider-configuration step receives the upstream model credential.
7. Creates a sandbox from a digest-pinned Pi image under a no-egress, hard-Landlock policy. The trusted advisor checkout, PR workspace, prepared GitHub context, and verified search binaries enter through advisor-only read-only Docker bind mounts before the first sandbox process starts. A capped tmpfs is the only writable application-data subtree. Before model code runs, a trusted probe reads every input canary, resolves the mounted checkout and `HEAD` through an explicit `GIT_DIR` and `GIT_WORK_TREE`, verifies that chmod, overwrite, replacement, and creation fail in every input, and exercises the complete runtime write lifecycle.
8. Runs the trusted `tools/pr-review-advisor/run-analysis.mts` entrypoint inside the sandbox. The unchanged multi-turn Pi SDK session reaches the host-configured model only through `https://inference.local/v1`; the sandbox receives an inert SDK key and neither the upstream model credential nor a GitHub token.
9. Runs the same advisor conversation in parallel for the primary GPT-5.6 Terra lane and an artifact-only Nemotron Ultra evaluation lane.
10. Opens one Pi session per model variant and reviews the PR in 16 bounded turns: seven analysis/commit pairs for scope/risk, terminology, correctness/state, security/trust, tests/regressions, CI/operations, and reconciliation, followed by draft and validation JSON synthesis turns in that same session. The terminology turn selects candidates semantically from changed explanatory text. Trusted code then traces each selected term across the base and head commits, including hyphen and space variants, changed source locations, and available history. Changed-location tracing streams the complete Git diff with bounded per-line memory, so selected terms remain traceable beyond 4 MiB of diff output. Repository occurrence counts and samples still use bounded `git grep` output and report when evidence is truncated. The tests/regressions turn analyzes E2E coverage and new-test gaps, while the CI/operations turn selects supported E2E jobs, targets, or fan-out. Only trusted identifiers from these receipts reach normalized E2E output; free-form model E2E prose is discarded. No second advisor session is opened, including for synthesis repair.
11. Gives each commit turn one job: apply one successful atomic commit for the preceding analysis. Finding commit turns update the finding ledger with one flat object containing homogeneous additions, updates, resolutions, and supersessions arrays plus a no-change reason. The terminology commit turn writes one separate canonical receipt through `pr_review_update_terminology`. A terminology decision must reference a trusted trace and changed file and line bound to the head commit. The commit tool is the turn's only active tool, and the runner rejects prose, other tool calls, or activity after the successful commit. Rejected attempts do not mutate either canonical store and can be corrected before one success. If a commit turn ends with no successful call and every attempt settled without mutating state, the runner permits one tool-only retry and then fails closed. Finding additions require a structured observed-versus-expected basis, a file and line, and eligibility for the active stage. Ledger findings receive stable `F-...` IDs, terminology decisions receive stable `T-...` IDs, and conclusion changes require a reason plus new evidence.
12. Treats open finding-ledger records and the terminology receipt as separate canonical results. Final synthesis cannot silently add, drop, merge, reword, or reclassify either result. Unresolved source-of-truth review entries must reference their covering open finding ID structurally rather than relying on prose matching. A terminology decision does not affect the merge recommendation by itself. A later correctness or security stage can create an ordinary finding only when terminology ambiguity has a concrete effect on behavior, security, data safety, a supported surface, evidence, test meaning, or release meaning.
13. Logs each turn start and settled status and writes the assistant response immediately, preserving partial failed/timed-out turn evidence and the raw transcript. If trusted prompt inputs are unavailable before the model session starts, the runner writes failed analysis and schema-valid final-result artifacts. If a later stage fails, already-committed canonical findings and terminology decisions remain in the low-confidence incomplete result instead of being replaced by a generic unavailable finding.
14. Retries transient provider failures such as HTTP 429 within the same session using one bounded exponential-backoff layer. GPT waits 6s, 12s, 24s, and 48s; Nemotron waits 9s, 18s, 36s, and 72s so parallel lanes do not retry in lockstep. The workflow still publishes the primary comment and lane artifacts after an incomplete analysis. An incomplete primary review fails its outcome step; the artifact-only evaluation lane does not affect the workflow result.
15. Validates and repairs the draft synthesis in the final turn of the same session. If that turn fails or emits malformed output, the runner preserves a schema-valid canonical draft with a limitation. A post-validation mismatch with the finding ledger or terminology receipt still fails closed.
16. Writes artifacts under the model-specific artifact directory in the writable runtime subtree, downloads them to the trusted host, and uploads them from the read-only analysis job. Example directories are `artifacts/pr-review-advisor/` and `artifacts/pr-review-advisor-nemotron-ultra/`.
17. Uses a separate publisher job with no model credential or untrusted worktree.
    It validates the primary artifact and live PR head/base.
    It then posts or updates one combined sticky PR comment marked by `<!-- nemoclaw-pr-review-advisor -->`.
    The primary lane remains authoritative for the assessment and recommended E2E guidance.
    The publisher compares normalized findings, terminology decisions, and E2E selections from the completed lanes.
    For terminology, it can show decisions that only the second-opinion lane selected and cases where the lanes assigned different dispositions to the same term and changed location.
    When the completed second-opinion lane includes a trusted E2E selector that the primary lane omits, the publisher shows an optional disagreement.
    The disagreement includes the selector and a publisher-authored coverage-gap reason in the same comment.
    A missing, malformed, or incomplete second-opinion result cannot suppress the primary result.
    The evaluation lane does not publish another review.
    Previous sticky-comment ingestion is disabled for both lanes.

The ordered stage array in `buildPromptTurns` is the source of truth for stage order, evidence, and
prompt text. Runtime numbering and prompt artifact names derive from that array, so adding or
reordering a stage does not require parallel orchestration changes.

`tools/pr-review-advisor/openshell.mts` owns the advisor-specific prepare, create, run, download, and
cleanup sequence. It uses the shared lifecycle and credential-boundary helpers in
`tools/openshell-agent/runtime.mts`, which are also used by the merge-conflict fixer.

Provider failures and timeouts settle the active turn before the analysis fails, so its status and
partial response remain available beside the raw transcript. Turn-artifact persistence failures are
also fatal. A finding mismatch after same-session synthesis validation is fatal as well. Fatal runs remain
visibly incomplete, but their final-result artifact preserves any open canonical findings committed
before the failure so later runs and reviewers do not lose substantive review history.

The workflow is advisory and must not be configured as an E2E-required status check. Its combined
comment lists trusted E2E recommendations, but does not dispatch or report pass/fail for E2E jobs.
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
- The advisor receives repo-confined read-only repository tools plus deterministic context tools. Repository paths must remain inside the checked-out analysis workspace after lexical and symlink resolution. Its only mutation tools update the in-memory finding ledger and terminology receipt; they cannot change repository or GitHub state.
- PR bodies, comments, titles, branch names, and diffs are treated as untrusted evidence, never as instructions.
- Manual target analysis validates the repository token, decimal PR number, and base-ref token before running any `git` command.
- Generated Pi configuration is written under the sandbox's runtime-only configuration directory, not uploaded artifacts.
- The review job is limited to `NVIDIA/NemoClaw` and has read-only GitHub permissions. Within it, only the trusted host provider-configuration step receives the upstream model secret.
- A separate trusted host step collects deterministic GitHub context with `github.token` and writes a bounded, identity-checked context file before model work. The sandbox receives that file, not the token.
- The OpenShell gateway binds only to loopback and holds the upstream provider credential. The sandbox uses `https://inference.local/v1` with an inert SDK key, and receives neither the provider credential nor a GitHub token.
- The separate publisher has pull-request write permission, but receives neither the model secret nor the untrusted PR worktree. It accepts only the bounded primary artifact from the same workflow run and rechecks the live PR head and base before commenting. Before rendering E2E guidance, it independently allowlists coverage IDs and selector tuples and ignores artifact-authored E2E prose. A newly added credential-free test can extend the job allowlist only through trusted-normalizer evidence bound to the same head SHA, changed-file path, and basename-derived selector ID.
- Sticky publication updates only a marker-bearing comment owned by `github-actions[bot]`; a user-authored marker cannot claim the update target.
  The rendered comment preserves its hidden identity metadata while enforcing a 60 KiB UTF-8 limit, and publication errors remain visible in the publisher logs.
- The workflow posts advisory comments only; it does not approve, request changes, merge, push, label, or dispatch E2E.
- Previous sticky-comment ingestion is disabled because issue comments are mutable and GitHub does not expose a durable comment-to-workflow ownership binding. Any future follow-up context must come from a verified immutable run artifact rather than comment metadata.
- During rollout, non-default advisor lanes may see an older trusted `main` checkout that has the workflow matrix but not the matching model support. The workflow treats that as trusted-main rollout skew and writes low-confidence skip artifacts in the lane-specific artifact directory. Do not run PR-controlled advisor code to bypass this gate; remove the gate only after the trusted `main` implementation always supports the parallel advisor lane.
- The checked-in risk plan is deterministic and additive. PR Review Advisor reviews every listed
  invariant and required job for missing evidence. The trusted E2E normalizer restores any listed
  job that the model omits or downgrades. The PR E2E controller separately dispatches every listed
  job without consuming the advisor's normalized result.

Risk plan version 13 maps runtime changes from these paths to the `focused-e2e` family:

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
The primary lane uses `azure/openai/gpt-5.6-terra`; the parallel Nemotron lane sets
`PR_REVIEW_ADVISOR_MODEL=nvidia/nvidia/nemotron-3-ultra` and reuses the same analyzer,
prompts, schema, safety boundary, and credential secret.

If advisor credentials are unavailable, the advisor writes a low-confidence unavailable result
instead of failing closed without artifacts.

## Artifacts

- `prompts/00-system.md` — system prompt sent to the advisor.
- `prompts/01-scope-risk-map-analysis.md` through `prompts/16-validate-synthesis-json.md` — seven alternating analysis/commit pairs followed by draft and validation synthesis turns in the same session, in execution order.
- `prompts/*.tool-results/` — deterministic, domain-specific context payloads exposed as real tools after the matching user turn. The complete untrusted diff appears only in the first turn, and repeated risk-plan projections use capped path samples.
- `turns/01-scope-risk-map-analysis.txt` through `turns/16-validate-synthesis-json.txt` — assistant output and completed/failed/timed-out status written as each turn settles.
- `context/drift-context.json` — deterministic drift and overlap context.
- `context/security-context.json` — deterministic security-risk context and the risk plan for the
  PR SHA.
- `context/validation-context.json` — deterministic acceptance, source-of-truth, static
  test-inventory, simplification-signal, and risk plan for the PR SHA, including the
  regression invariants reviewed for the PR.
- `context/pr.diff` — complete PR diff used by the advisor.
- `pr-review-advisor-raw-output.txt` — raw multi-turn advisor transcript and diagnostics.
- `pr-review-advisor-result.json` — normalized advisor result with findings projected from the canonical open ledger records, or execution metadata when analysis is unavailable.
- `pr-review-advisor-final-result.json` — normalized canonical result used for comments.
- `pr-review-advisor-finding-ledger.json` — all open, resolved, and superseded finding records with stable IDs and reasoned transition history, refreshed after every settled turn.
- `pr-review-advisor-terminology-ledger.json` — the canonical terminology receipt for the head commit, including decisions that reference a trusted trace, refreshed after every settled turn.
- `pr-review-advisor-summary.md` — markdown summary used in the job summary.
- `pr-review-advisor-detailed-review.md` — expanded acceptance, security, and source-of-truth review details.
- `pr-review-advisor-session.html` — exported advisor session transcript showing each user instruction before its context tools, the visible stage analysis before its canonical update, and the final read-only synthesis from both canonical stores.

The parallel Nemotron Ultra lane writes the same filenames under
`artifacts/pr-review-advisor-nemotron-ultra/` and uploads them as the
`pr-review-advisor-nemotron-ultra` artifact.

## Manual run

```bash
node --experimental-strip-types tools/pr-review-advisor/analyze.mts \
  --base origin/main \
  --head HEAD \
  --schema tools/pr-review-advisor/schema.json \
  --out-dir artifacts/pr-review-advisor
```

For this direct local invocation outside the workflow's OpenShell wrapper, set
`PR_REVIEW_ADVISOR_API_KEY` locally. Add
`PR_REVIEW_ADVISOR_MODEL=nvidia/nvidia/nemotron-3-ultra` to exercise the Nemotron Ultra lane
locally. Run `npm install` first so the Pi SDK dependency is available.

## Output contract

`tools/pr-review-advisor/schema.json` defines the normalized JSON result shape used for the PR
comment and future reporting work. Findings include probe-shaped fields for impact, verification
hints, and missing regression-test guidance so agents know what to check rather than treating findings
as generic commentary. The required `terminologyReview` field contains the canonical receipt with
each candidate's change type, disposition, meaning, contrast, established alternative, semantic
impact, recommendation, trace ID, and source bound to the head commit. The dispositions are `established`,
`justified`, `define`, `replace`, and `conflict`. The trusted terminology tools are
`pr_review_trace_term`, `pr_review_update_terminology`, and `pr_review_read_terminology`.
Trusted tracing verifies repository evidence after the model selects a candidate; it does not scan
or classify changed text to select terms. Every source-of-truth review item includes a `findingId`: unresolved items
reference their covering open ledger finding, while satisfied and not-applicable items use `null`.
Every result also includes nested `e2e.coverage` and `e2e.targets` guidance. The fields stay
separate in JSON, but comments and summaries combine their IDs into one `Recommended E2E` list and
one optional list. Duplicate IDs appear once. If a list is longer than the display limit, the output
reports how many more IDs exist. The trusted normalizer
restores deterministic requirements before model selections, retains only allowlisted coverage IDs
and supported selector tuples, and replaces model-authored reasons with trusted
reasons. It discards free-form E2E domains, new-test recommendations, and no-selection explanations.
The publisher compares the completed lanes after this normalization. It lists trusted
second-opinion-only selectors with a publisher-authored coverage-gap reason as optional
disagreements without adding them to the primary lane's recommended E2E guidance. It also compares
normalized terminology receipts and can show second-opinion-only or conflicting dispositions when
both lanes completed with decisions for the same head commit. These differences remain advisory and do not
change the primary assessment, merge posture, or recommended E2E guidance.
For a changed credential-free test, the normalizer also records structured head evidence only
after the trusted module-tag parser accepts the source; model-provided evidence is overwritten. The
trusted publisher independently repeats the ID and tuple checks, verifies that evidence against the
result head and changed-file identity, and renders only trusted IDs.
The compatibility schema retains `requiredTests` and `targets.required`, but those names describe
the normalized advisory tier, not merge requirements. Rendered comments label them as recommended;
the independent PR E2E controller does not consume advisor output.
Findings can also include safe simplification metadata with delete, stdlib,
native, YAGNI, or shrink tags; those suggestions must keep validation, security, data-loss prevention,
and required tests intact.
The canonical ledger normalizer reports `merge_as_is` only when a completed, non-low-confidence review
has no open findings.
It reports `merge_after_fixes` when any blocker, warning, or suggestion remains open.
It reserves `info_only` for skipped, unavailable, incomplete, or low-confidence review evidence, and reports
`superseded` when competing work replaces the PR.
These recommendations describe advisor findings only.
They never approve a PR, replace required human review, or change the repository's merge gates.
Maintainers still decide whether a warning blocks, and suggestions do not require a response.
Every result includes limitations and requires maintainer review.
