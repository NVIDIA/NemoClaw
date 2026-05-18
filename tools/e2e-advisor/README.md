<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E Advisor

The E2E Advisor is an SDK-powered PR reviewer for NemoClaw E2E coverage. It runs on internal
`NVIDIA/NemoClaw` pull requests, asks the advisor model to inspect the PR diff and repository, and posts a sticky
PR comment with required/optional E2E recommendations.

The advisor recommends E2E coverage from the PR diff and repository context rather than a fixed path-rule table. The advisor model is expected to inspect existing E2E workflows, scripts, source files, and nearby tests before recommending coverage.

## Workflow

`.github/workflows/e2e-advisor.yaml`:

1. Runs on `pull_request` and `workflow_dispatch`.
2. Skips user-fork PRs; it only analyzes PRs whose head repo is `NVIDIA/NemoClaw`.
3. Installs the pinned Pi SDK package.
4. Runs `tools/e2e-advisor/analyze.mts`.
5. Writes artifacts under `artifacts/e2e-advisor/`.
6. For eligible internal PRs, auto-dispatches the required selective E2E jobs.
7. Posts or updates a sticky PR comment marked by `<!-- nemoclaw-e2e-advisor -->`.

## Safety model

- Static analysis only.
- The advisor receives only read-only tools: `read`, `grep`, `find`, and `ls`.
- The workflow does not execute PR-provided scripts, tests, or package-manager lifecycle hooks.
- Generated advisor credential config is written under `/tmp`, not under uploaded artifacts.
- The job is gated to internal upstream PRs only.
- Automatic E2E dispatch is further restricted to PR authors with GitHub `OWNER` or `MEMBER`
  author association.
- Auto-dispatch runs the trusted `nightly-e2e.yaml` workflow from `main` and passes the PR head SHA
  as `target_ref`, so the workflow definition itself is not taken from the PR branch.
- The dispatcher is TypeScript executed by Node with `--experimental-strip-types`, avoiding a
  package install or build step in the secret-bearing advisor job.
- The dispatcher does not use a hardcoded job allowlist. It derives dispatchable job names from the
  target workflow's own `inputs.jobs` selective-dispatch predicates and ignores recommendations that
  do not match those jobs.

## Required secret

Configure this repository secret for E2E recommendations:

- `PI_E2E_ADVISOR_API_KEY`

The analyzer uses the fixed `openai/openai/gpt-5.5` advisor model and also accepts `OPENAI_API_KEY` for local runs.

If advisor credentials are unavailable, the advisor writes a low-confidence unavailable result instead of
making deterministic recommendations.

## Optional secret

- `E2E_ADVISOR_GITHUB_TOKEN`

If present, this token is used for sticky PR comments. Otherwise the workflow falls back to
`github.token`. Commenting is best-effort. Automatic E2E dispatch uses `github.token` with the
workflow's `actions: write` permission, not this optional comment token.

## Artifacts

- `e2e-advisor-prompt.md` — prompt sent to the advisor.
- `e2e-advisor-raw-output.txt` — raw advisor transcript and diagnostics.
- `e2e-advisor-result.json` — parsed advisor response or execution metadata.
- `e2e-advisor-session.html` — exported advisor session transcript.
- `e2e-advisor-final-result.json` — normalized result used for comments.
- `e2e-advisor-summary.md` — markdown summary used in the job summary/comment.
- `e2e-advisor-dispatch-result.json` — automatic E2E dispatch status.
- `e2e-advisor-dispatch-summary.md` — markdown dispatch summary.

## Manual run

```bash
node --experimental-strip-types tools/e2e-advisor/analyze.mts \
  --base origin/main \
  --head HEAD \
  --schema tools/e2e-advisor/schema.json \
  --out-dir artifacts/e2e-advisor
```

Set `E2E_ADVISOR_API_KEY` or `OPENAI_API_KEY` locally, or configure the repository `PI_E2E_ADVISOR_API_KEY` secret. Run `npm install` first so the Pi SDK dependency is available.

## Output contract

`tools/e2e-advisor/schema.json` defines the normalized JSON result shape used by the PR comment,
automatic dispatch, and future enforcement work.

Future enforcement should be implemented as a single dynamic required check that verifies the
recommended E2E jobs passed for the same PR head SHA.
