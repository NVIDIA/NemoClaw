<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E Advisor

The E2E Advisor is an SDK-powered PR reviewer for NemoClaw E2E coverage. It runs on internal
`NVIDIA/NemoClaw` pull requests, asks the advisor model to inspect the PR diff and repository, and posts a sticky
PR comment with required/optional E2E recommendations.

The advisor combines a small checked-in regression risk plan with model review of the PR diff and repository context. The deterministic plan establishes the minimum required jobs for known high-risk lifecycle, upgrade, agent, inference, messaging, platform, credential, and security surfaces. The model may add adjacent coverage but cannot remove that floor.
The target advisor also emits canonical `gh workflow run e2e.yaml` commands that use the workflow's `targets` or `jobs` inputs.
After model output is normalized, the analyzer applies a deterministic safety
net for timing-sensitive onboard infrastructure: changes to onboard behavior,
trace timing, scorecard analysis, the advisory performance-budget config, or
the unified E2E workflow require the `cloud-onboard` target so the PR refreshes
the trusted timing signal.

## Workflow

`.github/workflows/e2e-advisor.yaml`:

1. Runs on `pull_request` and `workflow_dispatch`.
2. Skips user-fork PRs; it only analyzes PRs whose head repo is `NVIDIA/NemoClaw`.
3. Installs the pinned Pi SDK package.
4. Runs `tools/e2e-advisor/analyze.mts` and `tools/e2e-advisor/targets.mts`.
5. Writes `risk-plan.json` and advisor artifacts under `artifacts/e2e-advisor/`.
6. Posts or updates sticky PR comments marked by `<!-- nemoclaw-e2e-advisor -->` and `<!-- nemoclaw-e2e-target-advisor -->`.

## Safety model

- Static analysis only.
- The advisor receives repo-confined `read`, `grep`, `find`, and `ls` tools plus deterministic, turn-scoped read-only context tools for metadata, changed files, risk plans, diffs, and response schemas.
- The workflow does not execute PR-provided scripts, tests, or package-manager lifecycle hooks.
- Generated advisor credential config is written under `/tmp`, not under uploaded artifacts.
- The job is gated to internal upstream PRs only.
- Target recommendations include canonical `gh workflow run` commands for
  `.github/workflows/e2e.yaml`, but the advisor job does not
  trigger those commands automatically.

## Post-merge shadow controller

The model-independent `.github/workflows/post-merge-e2e-risk-gate-shadow.yaml` workflow
uses the same checked-in risk-plan policy after a commit lands on `main`. It
does not consume model output or the advisor artifact. Instead,
`tools/e2e-advisor/post-merge-risk-gate.mts` confirms the trusted controller checkout,
builds a new plan from the exact `github.event.before` and `github.event.after` range,
and dispatches at most three `automaticJobs` to `e2e.yaml` against the merged
commit. The controller opts into GitHub's workflow-dispatch run details and
uses the returned run ID as the sole child-run selector, so a lookalike run
cannot win a polling race for the same correlation ID.

The child workflow validates that the exact checkout SHA equals the workflow's
own current `main` commit, verifies its reachability, and checks selective-job
inputs, plan hash, and correlation ID before E2E preparation or secret-bearing
jobs can run. If `main` advances before an older controller dispatches, that
child fails closed and the controller reports failure rather than executing the
older commit with current secrets. The shadow-only Vitest reporter
records the observed checkout SHA and pass, failure, skip, pending, and
unhandled-error counts for each job and matrix shard. The controller accepts
only signals bound to the expected SHA, plan hash, correlation ID, job, and
shard.

The start step records a SHA-256 digest of its private controller state in a
GitHub step output. After child artifacts are downloaded, the finish step reads
that state once and verifies the digest before parsing it or classifying any
evidence, so downloaded files cannot change the dispatch state used for the
check result.

The controller writes a check on the merged commit without posting a PR
comment or running the scheduled/manual scorecard. Complete unskipped evidence
reports success, selected E2E workflow or test failures for the merged commit report
failure, and incomplete, ambiguous, skipped, or cap-limited evidence that
requires manual expansion reports neutral. If no runtime risk family matches,
it reports success without dispatching E2E. This is post-merge shadow evidence,
not a required pre-merge check.

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
- `risk-plan.json` — deterministic risk families, invariants, and required jobs for the PR
  head commit and changed-file set, plus a capped `automaticJobs` subset,
  manual-expansion state, and the plan digest. Both E2E advisor projections consume the
  required-job floor, while the separate post-merge controller rebuilds the plan and
  dispatches the automatic subset.
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

The post-merge shadow check does not establish pre-merge enforcement. Any future required check
must verify complete E2E evidence for the same PR head commit without making model availability part
of the merge authority.
