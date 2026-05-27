<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# PR Review Advisor

The PR Review Advisor is an SDK-powered, NemoClaw-specific pull request reviewer. It runs as a
trusted GitHub Actions job, inspects PRs as read-only data, and posts a sticky advisory comment with
blockers, warnings, suggestions, acceptance coverage, security notes, and code-review follow-up guidance.

It complements the existing PR surfaces by keeping a NemoClaw maintainer code-review lens focused on the patch itself:

- sandbox and workflow security review;
- acceptance-clause coverage against linked issues;
- previous PR Review Advisor follow-up for code findings;
- codebase drift, monolith growth, and architecture guardrails;
- source-of-truth review for fallback, recovery, tolerant parsing, monkeypatching, and other localized workaround behavior;
- correctness and test-quality checks that CI cannot prove.

It intentionally does not report GitHub mergeability, branch protection, CI status, reviewer state, CodeRabbit state, or E2E pass/fail status; those are handled elsewhere in the PR UI.

## Workflow

`.github/workflows/pr-review-advisor.yaml`:

1. Runs on internal `pull_request` events and `workflow_dispatch`.
2. Checks out advisor implementation code from trusted `main` into `advisor/`.
3. Checks out PR content into `pr-workdir/` as inert read-only analysis data.
4. Installs a pinned Pi SDK package with lifecycle scripts disabled.
5. Waits for repository-required status checks, plus the E2E Advisor recommendation, to leave the pending/in-progress state.
6. Runs `tools/pr-review-advisor/analyze.mts` from the trusted checkout.
7. Opens one Pi session and reviews the PR as a short conversation: orientation/drift, security, acceptance/correctness/tests, then final JSON synthesis.
8. Writes artifacts under `artifacts/pr-review-advisor/`.
9. Posts or updates a sticky PR comment marked by `<!-- nemoclaw-pr-review-advisor -->`.

The workflow is advisory and must not be configured as a required status check. Making it required can
create circular wait behavior and defeats the goal of letting it observe settled required-check state.

## Safety model

- Static analysis only.
- PR-provided scripts, tests, package lifecycle hooks, and build tools are never executed.
- The advisor receives only read-only tools: `read`, `grep`, `find`, and `ls`.
- PR bodies, comments, titles, branch names, and diffs are treated as untrusted evidence, never as instructions.
- Generated advisor credential config is written under `/tmp`, not uploaded artifacts.
- The job is limited to upstream `NVIDIA/NemoClaw` PRs when model secrets are in scope.
- The workflow posts advisory comments only; it does not approve, request changes, merge, push, label, or dispatch E2E.
- Before model analysis, the workflow deterministically waits for required status checks from repository rulesets. If rulesets cannot be read, it falls back to the configured `PR_REVIEW_ADVISOR_REQUIRED_CHECK_FALLBACK_CONTEXTS` list.

## Required secret

Configure this repository secret for review analysis:

- `PR_REVIEW_ADVISOR_API_KEY`

The workflow also accepts the legacy `PI_PR_REVIEW_ADVISOR_API_KEY` secret as a
fallback. The analyzer uses the fixed `openai/openai/gpt-5.5` advisor model and
also accepts `OPENAI_API_KEY` for local runs.

If advisor credentials are unavailable, the advisor writes a low-confidence unavailable result
instead of failing closed without artifacts.

## Optional secret

- `PR_REVIEW_ADVISOR_GITHUB_TOKEN`

If present, this token is used for sticky PR comments. Otherwise the workflow falls back to
`github.token`. Commenting is best-effort.

## Artifacts

- `prompts/00-system.md` — system prompt sent to the advisor.
- `prompts/01-orient-drift.md` — orientation, codebase drift, overlaps, monolith, and localized-patch scan.
- `prompts/02-security.md` — security-review turn.
- `prompts/03-acceptance-correctness-tests.md` — acceptance, correctness, tests, and source-of-truth turn.
- `prompts/04-synthesize-json.md` — final JSON synthesis turn.
- `pr-review-advisor-raw-output.txt` — raw multi-turn advisor transcript and diagnostics.
- `pr-review-advisor-result.json` — parsed advisor response or execution metadata.
- `pr-review-advisor-final-result.json` — normalized result used for comments.
- `pr-review-advisor-summary.md` — markdown summary used in the job summary/comment.
- `pr-review-advisor-detailed-review.md` — expanded acceptance, security, and source-of-truth review details.
- `pr-review-advisor-session.html` — exported advisor session transcript.

## Manual run

```bash
node --experimental-strip-types tools/pr-review-advisor/analyze.mts \
  --base origin/main \
  --head HEAD \
  --schema tools/pr-review-advisor/schema.json \
  --out-dir artifacts/pr-review-advisor
```

Set `PR_REVIEW_ADVISOR_API_KEY` or `OPENAI_API_KEY` locally, or configure the repository
`PR_REVIEW_ADVISOR_API_KEY` secret. Run `npm install` first so the Pi SDK dependency is
available.

## Output contract

`tools/pr-review-advisor/schema.json` defines the normalized JSON result shape used for the PR
comment and future reporting work. The advisor is intentionally advisory: every result includes
limitations and requires human maintainer review.
