<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# PR Review Advisor

The PR Review Advisor is an SDK-powered, NemoClaw-specific pull request reviewer. It runs as a
trusted GitHub Actions job, inspects PRs as read-only data, and posts a sticky comment with blockers,
warnings, and suggestions. Artifacts retain
acceptance coverage, security notes, and other review context.

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
5. Builds the deterministic regression risk plan and E2E inventory in trusted code and injects them into the review contexts.
6. Runs `tools/pr-review-advisor/analyze.mts` from the trusted checkout.
7. Runs the same advisor conversation in parallel for the primary GPT-5.6 Terra lane and an artifact-only Nemotron Ultra evaluation lane.
8. Opens one Pi session per model variant and reviews the PR in 14 bounded turns: six small analysis/commit pairs for scope/risk, correctness/state, security/trust, tests/regressions, CI/operations, and reconciliation, followed by draft and validation JSON synthesis turns in that same session. The tests/regressions turn analyzes E2E coverage and new-test gaps, while the CI/operations turn selects supported E2E jobs, targets, or fan-out. Only trusted identifiers from these receipts reach normalized E2E output; free-form model E2E prose is discarded. No second advisor session is opened, including for synthesis repair.
9. Gives each commit turn one job: apply one successful atomic ledger commit for the preceding analysis. The model-facing commit is one flat object with homogeneous additions, updates, resolutions, and supersessions arrays plus a no-change reason; legacy nested operation unions and stringified arrays are rejected. Additions require a structured observed-versus-expected basis, a file and line, and eligibility for the active stage. Positives, advisor/provider state, prior-review process state, open-PR overlap, merge coordination, and live CI/E2E status stay in prose receipts rather than becoming findings. The ledger mutation tool is the turn's only active tool, and the runner rejects prose, other tool calls, or activity after the successful commit. Rejected attempts do not mutate the ledger and may be corrected before one success. If a commit turn ends with no successful call and every attempt settled without mutating state, the runner permits one tool-only retry and then fails closed. Ledger findings receive stable `F-...` IDs, and conclusion changes require a reason plus new evidence; final synthesis can only read the ledger.
10. Treats open ledger records as the canonical finding set. Final synthesis cannot silently add, drop, merge, reword, or reclassify those findings. Unresolved source-of-truth review entries must reference their covering open ledger ID structurally rather than relying on prose matching.
11. Logs each turn start and settled status and writes the assistant response immediately, preserving partial failed/timed-out turn evidence and the raw transcript. If a later stage fails, already-committed canonical findings remain in the low-confidence incomplete result instead of being replaced by a generic unavailable finding.
12. Retries transient provider failures such as HTTP 429 within the same session using one bounded exponential-backoff layer. GPT waits 6s, 12s, 24s, and 48s; Nemotron waits 9s, 18s, 36s, and 72s so parallel lanes do not retry in lockstep. The workflow still publishes the primary comment and lane artifacts after an incomplete analysis. An incomplete primary review fails its outcome step; the artifact-only evaluation lane does not affect the workflow result.
13. Validates and repairs the draft synthesis in the final turn of the same session. If that turn fails or emits malformed output, the runner preserves a schema-valid canonical draft with a limitation; a post-validation ledger mismatch still fails closed.
14. Writes artifacts under the model-specific artifact directory, for example `artifacts/pr-review-advisor/` and `artifacts/pr-review-advisor-nemotron-ultra/`.
15. Uploads each lane's artifacts from the read-only analysis job. A separate publisher job receives no model credential or untrusted worktree, validates the primary artifact and live PR head/base, then posts or updates one combined sticky PR comment marked by `<!-- nemoclaw-pr-review-advisor -->`. The evaluation lane does not publish another review. Previous sticky-comment ingestion is disabled for both lanes.

The ordered stage array in `buildPromptTurns` is the source of truth for stage order, evidence, and
prompt text. Runtime numbering and prompt artifact names derive from that array, so adding or
reordering a stage does not require parallel orchestration changes.

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
- The advisor receives repo-confined read-only repository tools plus deterministic context tools. Repository paths must remain inside the checked-out analysis workspace after lexical and symlink resolution. Its only mutation tool updates the in-memory finding ledger; it cannot change repository or GitHub state.
- PR bodies, comments, titles, branch names, and diffs are treated as untrusted evidence, never as instructions.
- Manual target analysis validates the repository token, decimal PR number, and base-ref token before running any `git` command.
- Generated advisor credential config is written under `/tmp`, not uploaded artifacts.
- The analysis job is limited to `NVIDIA/NemoClaw`, has read-only GitHub permissions, and is the only job that receives the model secret.
- The analyzer collects deterministic GitHub context before model work, then removes GitHub tokens from the process environment.
  After registering the model credential in the in-memory SDK auth store, it also removes that credential from the process environment before model turns begin.
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

## Required secret

Configure this repository secret for review analysis:

- `PR_REVIEW_ADVISOR_API_KEY`

The analyzer uses the OpenAI-compatible `https://inference-api.nvidia.com/v1` service.
The primary lane uses `azure/openai/gpt-5.6-terra`; the parallel Nemotron lane sets
`PR_REVIEW_ADVISOR_MODEL=nvidia/nvidia/nemotron-3-ultra` and reuses the same analyzer,
prompts, schema, safety boundary, and credential secret.

If advisor credentials are unavailable, the advisor writes a low-confidence unavailable result
instead of failing closed without artifacts.

## Artifacts

- `prompts/00-system.md` — system prompt sent to the advisor.
- `prompts/01-scope-risk-map-analysis.md` through `prompts/14-validate-synthesis-json.md` — six alternating analysis/commit pairs followed by draft and validation synthesis turns in the same session, in execution order.
- `prompts/*.tool-results/` — bounded deterministic, domain-specific context payloads exposed as real tools after the matching user turn. The untrusted truncated diff appears only in the first turn, and repeated risk-plan projections use capped path samples.
- `turns/01-scope-risk-map-analysis.txt` through `turns/14-validate-synthesis-json.txt` — assistant output and completed/failed/timed-out status written as each turn settles.
- `context/drift-context.json` — deterministic drift and overlap context.
- `context/security-context.json` — deterministic security-risk context and the risk plan for the
  PR SHA.
- `context/validation-context.json` — deterministic acceptance, source-of-truth, static
  test-inventory, simplification-signal, and risk plan for the PR SHA, including the
  regression invariants reviewed for the PR.
- `context/pr.diff` — truncated PR diff used by the advisor.
- `pr-review-advisor-raw-output.txt` — raw multi-turn advisor transcript and diagnostics.
- `pr-review-advisor-result.json` — normalized advisor result with findings projected from the canonical open ledger records, or execution metadata when analysis is unavailable.
- `pr-review-advisor-final-result.json` — normalized canonical result used for comments.
- `pr-review-advisor-finding-ledger.json` — all open, resolved, and superseded finding records with stable IDs and reasoned transition history, refreshed after every settled turn.
- `pr-review-advisor-summary.md` — markdown summary used in the job summary.
- `pr-review-advisor-detailed-review.md` — expanded acceptance, security, and source-of-truth review details.
- `pr-review-advisor-session.html` — exported advisor session transcript showing each user instruction before its context tools, the visible stage analysis before its ledger update, and the final read-only ledger synthesis.

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

Set `PR_REVIEW_ADVISOR_API_KEY` locally, or configure the repository
`PR_REVIEW_ADVISOR_API_KEY` secret. Add `PR_REVIEW_ADVISOR_MODEL=nvidia/nvidia/nemotron-3-ultra`
to exercise the Nemotron Ultra lane locally. Run `npm install` first so the Pi SDK dependency is
available.

## Output contract

`tools/pr-review-advisor/schema.json` defines the normalized JSON result shape used for the PR
comment and future reporting work. Findings include probe-shaped fields for impact, verification
hints, and missing regression-test guidance so agents know what to check rather than treating findings
as generic commentary. Every source-of-truth review item includes a `findingId`: unresolved items
reference their covering open ledger finding, while satisfied and not-applicable items use `null`.
Every result also includes nested `e2e.coverage` and `e2e.targets` guidance. The fields stay
separate in JSON, but comments and summaries combine their IDs into one `Recommended E2E` list and
one optional list. Duplicate IDs appear once. If a list is longer than the display limit, the output
reports how many more IDs exist. The trusted normalizer
restores deterministic requirements before model selections, retains only allowlisted coverage IDs
and supported selector tuples, and replaces model-authored reasons with trusted
reasons. It discards free-form E2E domains, new-test recommendations, and no-selection explanations.
For a changed credential-free test, the normalizer also records structured head evidence only
after the trusted module-tag parser accepts the source; model-provided evidence is overwritten. The
trusted publisher independently repeats the ID and tuple checks, verifies that evidence against the
result head and changed-file identity, and renders only trusted IDs.
The compatibility schema retains `requiredTests` and `targets.required`, but those names describe
the normalized advisory tier, not merge requirements. Rendered comments label them as recommended;
the independent PR E2E controller does not consume advisor output.
Findings can also include safe simplification metadata with delete, stdlib,
native, YAGNI, or shrink tags; those suggestions must keep validation, security, data-loss prevention,
and required tests intact. Only blockers set a blocking advisory recommendation; results without
blockers are info-only unless superseded. That recommendation is review input, never merge
authorization. Warnings do not block. Suggestions do not require a response. Every result includes
limitations and requires maintainer review.
