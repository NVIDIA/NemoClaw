<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E Advisor

The E2E Advisor is an SDK-powered PR reviewer for NemoClaw E2E coverage. It analyzes same-repository and fork pull requests, asks the advisor model to inspect the PR diff and repository, and posts a sticky PR comment with required/optional E2E recommendations.

The advisor combines a small checked-in regression risk plan with model review of the PR diff and repository context. The deterministic plan establishes the minimum required jobs for known high-risk lifecycle, upgrade, agent, inference, messaging, platform, credential, and security surfaces. The model may add adjacent coverage but cannot remove that floor.
The target advisor also emits canonical `gh workflow run e2e.yaml` commands that use the workflow's `targets` or `jobs` inputs.
After model output is normalized, the analyzer applies a deterministic safety
net for timing-sensitive onboard infrastructure: changes to onboard behavior,
trace timing, scorecard analysis, the advisory performance-budget config, or
the unified E2E workflow require the `cloud-onboard` target so the PR refreshes
the trusted timing signal.

## Workflow

`.github/workflows/e2e-advisor.yaml`:

1. Runs same-repository PRs on `pull_request`, fork PRs on `pull_request_target`, and maintainer-requested analysis on `workflow_dispatch`.
2. Checks out executable advisor code from trusted `NVIDIA/NemoClaw` `main` and treats the PR checkout as inert analysis data.
3. For `pull_request_target`, fetches the PR head into an isolated worktree and verifies it matches the triggering head SHA before exporting the analysis path.
4. Removes symlinks from the analysis worktree before any secret-bearing advisor step. The event name is part of the concurrency key so the skipped `pull_request` run cannot cancel the fork's useful `pull_request_target` run.
5. Installs the pinned Pi SDK package.
6. Runs `tools/e2e-advisor/analyze.mts` and `tools/e2e-advisor/targets.mts`.
7. Writes `risk-plan.json` and advisor artifacts under `artifacts/e2e-advisor/`.
8. Posts or updates sticky PR comments marked by `<!-- nemoclaw-e2e-advisor -->` and `<!-- nemoclaw-e2e-target-advisor -->`.

## Safety model

- Static analysis only.
- The advisor receives repo-confined `read`, `grep`, `find`, and `ls` tools plus deterministic, turn-scoped read-only context tools for metadata, changed files, risk plans, diffs, and response schemas.
- The workflow executes advisor implementation only from trusted `main`; it does not execute PR-provided scripts, tests, or package-manager lifecycle hooks.
- Fork PRs use `pull_request_target` only when the head repository differs from `NVIDIA/NemoClaw`. The triggering head SHA is bound to the fetched pull ref before analysis, and symlinks are removed from the inert worktree before the model credential is exposed.
- `pull_request` and `pull_request_target` use separate concurrency groups so parallel trigger paths cannot cancel one another.
- Generated advisor credential config is written under `/tmp`, not under uploaded artifacts.
- Target recommendations include canonical `gh workflow run` commands for
  `.github/workflows/e2e.yaml`, but the advisor job does not
  trigger those commands automatically.

## Required live PR check

The model-independent `.github/workflows/required-live-e2e.yaml` workflow owns the
required `E2E / Required Live` check for same-repository pull requests after
`CI / Pull Request` completes.
It does not consume model output or advisor artifacts.
Instead, `tools/e2e/required-live.mts` resolves the open pull request for the
triggering revision, reads its complete changed-file list, and builds a new plan
from the checked-in risk policy.
The controller dispatches every job in `requiredJobs` through `e2e.yaml`.
If no runtime risk family matches, it reports success without dispatching live E2E.

The controller verifies the pull request identity again immediately before
dispatch.
It also records the trusted controller revision, requires that revision to
still be the current `main` revision immediately before dispatch, and accepts
only a child workflow run created from that same revision.
The child workflow validates that the pull request is still open, belongs to
the base repository, and still points to the requested checkout SHA before E2E
preparation or secret-bearing jobs can run.
It also requires selective jobs with no `targets` input, a valid plan hash,
and a valid correlation ID.
The controller uses GitHub's returned workflow run ID as the sole child-run
selector for waiting, evidence download, and completion.

The Vitest reporter records the observed checkout SHA and pass, failure, skip,
pending, and unhandled-error counts for each selected job and matrix shard.
The checked workflow boundary requires every job named by the deterministic
policy to expose its matching job identity, attach the reporter to every
Vitest invocation, and always upload its evidence artifact.
The controller accepts only signals bound to the expected SHA, plan hash,
correlation ID, job, and shard.
It also records a SHA-256 digest of its private dispatch state and verifies that
digest before parsing downloaded evidence.

The check has a binary result.
It succeeds only when the correlated workflow succeeds and every expected job
shard produces one complete, unskipped pass.
Workflow failures, failed tests, missing or duplicate signals, skipped or
pending tests, interrupted runs, and controller or evidence-validation errors
all fail the check.
Evidence download has its own 10-minute limit within the coordinator's
180-minute job budget, and exceeding that limit fails the check.
Pull request synchronization, reopening, or closure cancels active child runs
for that pull request, and the E2E workflow cancels a superseded child run when
a new revision is dispatched.

E2E Advisor remains advisory.
It uses the same deterministic policy as a recommendation floor and may add
adjacent coverage, but its model output and availability never determine the
required check.

## Required secret

Configure this repository secret for E2E recommendations:

- `PI_E2E_ADVISOR_API_KEY`

The analyzer uses the fixed `openai/openai/gpt-5.5` advisor model through the
OpenAI-compatible `https://inference-api.nvidia.com/v1` service.

If advisor credentials are unavailable, the advisor writes a low-confidence unavailable result instead of
making deterministic recommendations.

## Optional secret

- `E2E_ADVISOR_GITHUB_TOKEN`

If present, this token is used for sticky PR comments. Otherwise the workflow falls back to
`github.token`. Commenting is best-effort. The advisor only recommends target
dispatch commands; it does not trigger E2E workflows automatically.

## Artifacts

- `e2e-advisor-prompt.md` — task prompt sent to the advisor. Diff, changed files, metadata, and schema are exposed through deterministic turn-scoped context tools and captured in the session transcript.
- `risk-plan.json` — deterministic risk families, invariants, required jobs,
  changed files, and the plan digest for the pull request revision.
  Both E2E Advisor projections consume this required-job floor.
  The required live controller independently rebuilds the plan from GitHub's
  pull request file list and dispatches every selected job, so this advisor
  artifact is not an input to the required check.
- `e2e-advisor-raw-output.txt` — raw advisor transcript and diagnostics.
- `e2e-advisor-result.json` — parsed advisor response or execution metadata.
- `e2e-advisor-session.html` — exported advisor session transcript.
- `e2e-advisor-final-result.json` — normalized result used for comments.
- `e2e-advisor-summary.md` — markdown summary used in the job summary/comment.
- `e2e-target-advisor-*.{md,txt,json,html}` — target-selection prompt, raw transcript, normalized results, session export, and summary used for the target recommendation comment.

## Manual run

```bash
node --experimental-strip-types tools/e2e-advisor/analyze.mts \
  --base origin/main \
  --head HEAD \
  --schema tools/e2e-advisor/schema.json \
  --out-dir artifacts/e2e-advisor

node --experimental-strip-types tools/e2e-advisor/targets.mts \
  --base origin/main \
  --head HEAD \
  --schema tools/e2e-advisor/targets-schema.json \
  --out-dir artifacts/e2e-advisor
```

Set `E2E_ADVISOR_API_KEY` locally, or configure the repository `PI_E2E_ADVISOR_API_KEY`
secret. Run `npm install` first so the Pi SDK dependency is available.

## Output contract

`tools/e2e-advisor/schema.json` defines the normalized coverage recommendation shape.
`tools/e2e-advisor/targets-schema.json` defines the normalized target recommendation shape used by the `targets` and `jobs` dispatch commands.

The required live check verifies complete E2E evidence for the same pull
request revision without making model availability part of merge authority.
