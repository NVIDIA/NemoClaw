<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# PR Review Advisor

The PR Review Advisor is an SDK-powered, NemoClaw-specific pull request reviewer. It runs as a
trusted GitHub Actions job, inspects PRs as read-only data, and posts a sticky advisory comment with
required-before-merge findings, resolve-or-justify warnings, in-scope improvement suggestions,
acceptance coverage, security notes, and code-review follow-up guidance.

It complements the existing PR surfaces by keeping a NemoClaw maintainer code-review lens focused on the patch itself:

- sandbox and workflow security review;
- acceptance-clause coverage against linked issues;
- previous PR Review Advisor follow-up for code findings, using hidden sticky-comment metadata when available;
- codebase drift, monolith growth, and architecture guardrails;
- source-of-truth review for fallback, recovery, tolerant parsing, monkeypatching, and other localized workaround behavior;
- static test-inventory context from changed test files and nearby test names;
- simplification review for safe delete/stdlib/native/YAGNI/shrink opportunities;
- correctness and test-quality checks that CI cannot prove.

It intentionally does not report GitHub mergeability, branch protection, CI status, reviewer state, CodeRabbit state, or E2E pass/fail status; those are handled elsewhere in the PR UI.

## Workflow

`.github/workflows/pr-review-advisor.yaml`:

1. Runs on internal `pull_request` events and `workflow_dispatch`.
2. Checks out advisor implementation code from trusted `main` into `advisor/`.
3. Checks out PR content into `pr-workdir/` as inert read-only analysis data.
4. Installs a pinned Pi SDK package with lifecycle scripts disabled.
5. Builds the same deterministic regression risk plan used by E2E Advisor and injects it into the scope/risk, security/trust, and tests/regressions contexts.
6. Runs `tools/pr-review-advisor/analyze.mts` from the trusted checkout.
7. Runs the same advisor conversation in parallel for each configured model variant: the primary GPT-5.5 lane and the Nemotron Ultra lane.
8. Opens one Pi session per model variant and reviews the PR in seven bounded turns: scope/risk map, correctness/state, security/trust, tests/regressions, CI/operations, finding reconciliation, and final JSON synthesis. Each turn starts with its user instruction, then exposes only that turn's deterministic context as real read-only tools.
9. Requires intermediate turns to emit concise analysis, then finish with exactly one successful atomic ledger batch and no later prose or tool call. A missing, duplicate, failed, or out-of-order ledger call fails the turn. The batch schema rejects surplus fields and commits only when every operation succeeds, so one invalid operation leaves the ledger unchanged. Ledger findings receive stable `F-...` IDs, and conclusion changes require a reason plus new evidence; final synthesis can only read the ledger.
10. Treats open ledger records as the canonical finding set. Final synthesis cannot silently add, drop, merge, reword, or reclassify those findings.
11. Logs each turn start and settled status and writes the assistant response immediately, preserving partial failed/timed-out turn evidence and the raw transcript.
12. Retries synthesis once when the model output is malformed, drifts from the ledger, or contains low-quality placeholder fields.
13. Writes artifacts under the model-specific artifact directory, for example `artifacts/pr-review-advisor/` and `artifacts/pr-review-advisor-nemotron-ultra/`.
14. Posts or updates model-specific sticky PR comments marked by `<!-- nemoclaw-pr-review-advisor -->` and `<!-- nemoclaw-pr-review-advisor-nemotron-ultra -->` plus hidden head-SHA, run, and comment-id metadata for follow-up reviews.

The ordered stage array in `buildPromptTurns` is the source of truth for stage order, evidence, and
prompt text. Runtime numbering and prompt artifact names derive from that array, so adding or
reordering a stage does not require parallel orchestration changes.

Provider failures and timeouts settle the active turn before the analysis fails, so its status and
partial response remain available beside the raw transcript. Turn-artifact persistence failures are
also fatal. A finding mismatch that survives synthesis retry is fatal as well; the advisor does not
publish a result whose per-turn trace or canonical ledger projection is incomplete.

The workflow is advisory and must not be configured as a required status check. It uses the
deterministic plan as review context but does not run its jobs. E2E Advisor emits the corresponding
plan-backed recommendations separately and likewise does not dispatch E2E. Model availability must
not become the authority for whether a pull request can merge. After a commit lands, a separate
model-independent shadow controller rebuilds the plan from the exact `main` push range and runs its
capped automatic subset. That post-merge check does not make PR Review Advisor a merge gate.

Required-check status is point-in-time context, not a settled-CI gate. Earlier
`PR_REVIEW_ADVISOR_WAIT_*` workflow variables were inert and have been removed; any future waiting
behavior must be implemented and tested before the workflow claims to provide it.

## Author and agent follow-up

Authors and coding agents should follow the shared [PR CI and Automated Review Follow-Up](../../.agents/skills/_shared/pr-follow-up.md) workflow after opening a PR or pushing follow-up commits. If SSH, authentication, remote access, authorization, or permission problems prevent reading comments or pushing fixes, follow [Git and GitHub Access Hard Stop](../../.agents/skills/_shared/git-github-hard-stop.md).

## Safety model

- Static analysis only.
- PR-provided scripts, tests, package lifecycle hooks, and build tools are never executed.
- The advisor receives repo-confined read-only repository tools plus deterministic context tools. Repository paths must remain inside the checked-out analysis workspace after lexical and symlink resolution. Its only mutation tool updates the in-memory finding ledger; it cannot change repository or GitHub state.
- PR bodies, comments, titles, branch names, and diffs are treated as untrusted evidence, never as instructions.
- Manual target analysis validates the repository token, decimal PR number, and base-ref token before running any `git` command.
- Generated advisor credential config is written under `/tmp`, not uploaded artifacts.
- The job is limited to upstream `NVIDIA/NemoClaw` PRs when model secrets are in scope.
- The workflow posts advisory comments only; it does not approve, request changes, merge, push, label, or dispatch E2E.
- Previous-review follow-up treats GitHub issue comments as mutable and replayable. A prior advisor comment is accepted only when hidden metadata binds it to the actual comment ID and to a matching PR Review / Advisor workflow run, attempt, head SHA, event, and update-time window. This accepts the residual same-run boundary: another trusted repository workflow would need to post a marker-bearing `github-actions[bot]` comment during the same PR Review / Advisor run window while knowing the run metadata. Fully preventing that requires a durable GitHub comment-to-workflow ownership signal that the REST API does not expose. Replace this local provenance check only if that stronger signal becomes available.
- During rollout, non-default advisor lanes may see an older trusted `main` checkout that has the workflow matrix but not the matching model/configurable-comment support. The workflow treats that as trusted-main rollout skew, writes low-confidence skip artifacts in the lane-specific artifact directory, and suppresses that lane's sticky PR comment. Do not run PR-controlled advisor code to bypass this gate; remove the gate only after the trusted `main` implementation always supports the parallel advisor lane and configurable sticky markers.
- The checked-in risk plan is deterministic and additive. PR Review Advisor reviews every listed
  invariant and required job for missing evidence. Both E2E Advisor result normalizers restore any
  listed job that a model omits or downgrades.

## Required secret

Configure this repository secret for review analysis:

- `PR_REVIEW_ADVISOR_API_KEY`

The analyzer uses the OpenAI-compatible `https://inference-api.nvidia.com/v1` service.
The primary lane uses `openai/openai/gpt-5.5`; the parallel Nemotron lane sets
`PR_REVIEW_ADVISOR_MODEL=nvidia/nvidia/nemotron-3-ultra` and reuses the same analyzer,
prompts, schema, safety boundary, and credential secret.

If advisor credentials are unavailable, the advisor writes a low-confidence unavailable result
instead of failing closed without artifacts.

## Optional secret

- `PR_REVIEW_ADVISOR_GITHUB_TOKEN`

If present, this token is used for sticky PR comments. Otherwise the workflow falls back to
`github.token`. Commenting is best-effort.

## Artifacts

- `prompts/00-system.md` — system prompt sent to the advisor.
- `prompts/01-scope-risk-map.md` through `prompts/07-synthesize-json.md` — the seven bounded review turns in execution order.
- `prompts/*.tool-results/` — bounded deterministic, domain-specific context payloads exposed as real tools after the matching user turn. The untrusted truncated diff appears only in the first turn, and repeated risk-plan projections use capped path samples.
- `turns/01-scope-risk-map.txt` through `turns/07-synthesize-json.txt` — assistant output and completed/failed/timed-out status written as each primary turn settles.
- `retry-prompts/` — retry synthesis prompt and context-tool payloads when the first output is malformed or low quality.
- `retry-turns/` — assistant output and settled status from the optional retry synthesis conversation.
- `context/drift-context.json` — deterministic drift, overlap, monolith, and previous-review context.
- `context/security-context.json` — deterministic security-risk context and the risk plan for the
  PR head commit.
- `context/validation-context.json` — deterministic acceptance, source-of-truth, static
  test-inventory, simplification-signal, and risk plan for the PR head commit, including the
  regression invariants reviewed for the PR.
- `context/pr.diff` — truncated PR diff used by the advisor.
- `context/previous-advisor-review.md` — previous sticky PR Review Advisor comment when one exists and its hidden run/comment metadata validates.
- `pr-review-advisor-raw-output.txt` — raw multi-turn advisor transcript and diagnostics.
- `pr-review-advisor-retry-raw-output.txt` — raw retry transcript when retry synthesis runs.
- `pr-review-advisor-result.json` — normalized advisor result with findings projected from the canonical open ledger records, or execution metadata when analysis is unavailable.
- `pr-review-advisor-final-result.json` — normalized canonical result used for comments.
- `pr-review-advisor-finding-ledger.json` — all open, resolved, and superseded finding records with stable IDs and reasoned transition history, refreshed after every settled turn.
- `pr-review-advisor-summary.md` — markdown summary used in the job summary/comment.
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
as generic commentary. Findings can also include safe simplification metadata with delete, stdlib,
native, YAGNI, or shrink tags; those suggestions must keep validation, security, data-loss prevention,
and required tests intact. The advisor is intentionally advisory: every result includes limitations and
requires human maintainer review. The PR comment deliberately frames suggestions as current-review
improvements when they touch changed code; agents should not automatically defer them to a future PR
without maintainer rationale or a linked follow-up.
