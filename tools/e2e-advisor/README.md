<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E Advisor

The E2E Advisor is an SDK-powered PR reviewer for NemoClaw E2E coverage. It runs on internal
`NVIDIA/NemoClaw` pull requests, asks the advisor model to inspect the PR diff and repository, and posts a sticky
PR comment with required/optional E2E recommendations.

The advisor recommends E2E coverage from the PR diff and repository context rather than a fixed path-rule table. The advisor model is expected to inspect existing E2E workflows, target definitions, source files, and nearby tests before recommending coverage.
The target advisor also emits canonical `gh workflow run e2e.yaml` commands that use the workflow's `targets` or `jobs` inputs.

## Workflow

`.github/workflows/e2e-advisor.yaml`:

1. Runs on `pull_request` and `workflow_dispatch`.
2. Skips user-fork PRs; it only analyzes PRs whose head repo is `NVIDIA/NemoClaw`.
3. Installs the pinned Pi SDK package.
4. Runs `tools/e2e-advisor/analyze.mts` and `tools/e2e-advisor/targets.mts`.
5. Writes artifacts under `artifacts/e2e-advisor/`.
6. Posts or updates sticky PR comments marked by `<!-- nemoclaw-e2e-advisor -->` and `<!-- nemoclaw-e2e-target-advisor -->`.

## Safety model

- Static analysis only.
- The advisor receives only read-only tools: `read`, `grep`, `find`, and `ls`.
- The workflow does not execute PR-provided scripts, tests, or package-manager lifecycle hooks.
- Generated advisor credential config is written under `/tmp`, not under uploaded artifacts.
- The job is gated to internal upstream PRs only.
- Target recommendations include canonical `gh workflow run` commands for
  `.github/workflows/e2e.yaml`, but the advisor job does not
  trigger those commands automatically.

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

- `e2e-advisor-prompt.md` — task prompt sent to the advisor. Diff, changed files, metadata, and schema are injected into the Pi session as deterministic synthetic tool results and captured in the session transcript.
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

Future enforcement should be implemented as a single dynamic required check that verifies the
recommended E2E jobs passed for the same PR head SHA.
