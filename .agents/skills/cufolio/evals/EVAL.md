<!--
SPDX-FileCopyrightText: Copyright (c) 2023-2025 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Evaluating the cufolio skill

This directory holds the agent-level evaluation assets for the `cufolio` skill. They sit
alongside two other testing layers in the repo (see the repo `tests/` directory):

| Layer | Where | What it checks | GPU? | Keys? |
|---|---|---|---|---|
| 1. Compliance | `tests/test_skill.py` | SKILL.md spec + `evals.json` schema | No | No |
| 2. Publish-gate agent evals | `evals/evals.json` (NV-BASE) | with/without-skill agent uplift for the catalog | Yes | `NVIDIA_INFERENCE_KEY` |
| 3. Skill performance benchmarks | `tests/test_skill_benchmarks.py` + `tests/benchmarks/benchmark_workflows.py` + `tests/benchmarks/thresholds.toml` | the SKILL.md workflows meet quantitative standards | Yes | No |

This file documents **Layer 2** (the NV-BASE agent evals). Layer 1 runs in normal CI; Layer 3 is
described in `tests/benchmarks/benchmark_workflows.py` / `tests/benchmarks/thresholds.toml`.

## Dataset

There are two datasets, same schema:

- `evals.json` — the **CI publish-gate set (P0, 4 cases)**: 2 positives
  (`build-optimal-cvar`, `efficient-frontier-plot`) + 2 strong negatives
  (`neg-vehicle-routing`, `neg-nn-price-forecast`). Sized to finish inside the
  ~1h NV-CARPS CI cap (see Notes).
- `evals-full.json` — the **full set (9 cases)**: all positives and negatives,
  run on the nightly/manual job (longer timeout) for the published catalog benchmark.

`evals.json` follows the NV-BASE / agentskills.io eval format. Each case has:

- `id` — unique identifier
- `question` — the user prompt fed to the agent
- `expected_skill` — `"cufolio"` for positive cases, `null` for negatives (skill must stay silent)
- `expected_script` — `null` (this is an instruction-only skill; it ships no scripts)
- `ground_truth` — reference answer used by the accuracy judge
- `expected_behavior` — the ordered steps the agent should take (each graded YES/NO)

The positive `expected_behavior` lists deliberately encode the SKILL.md **Traps** (the skill's value
over reasoning from scratch): forcing `c_max=0.0` to avoid the all-cash optimum, passing
`show_discretized_portfolios=False`, using the manual loop only when weights are needed, and always
solving with the cuOpt `SOLVER_SETTINGS`. A baseline agent (no skill) typically misses these.

## Prerequisites

- A GPU host with NVIDIA cuOpt + cuML (the [Brev launchable](https://brev.nvidia.com/launchable/deploy?launchableID=env-360InRZzyHqDnJYQKIxaSggF8xI)
  works), and the `cufolio` package installed (`uv sync --extra cuda12` or `--extra cuda13`).
- Network access (the positive cases download the S&P 500 price data on first run).
- NV-BASE installed and configured with `NVIDIA_INFERENCE_KEY` from inference.nvidia.com.

## Running

```bash
# (optional) generate/refresh a draft dataset, then hand-tune it
nv-base create-eval-dataset skills/cufolio

# spec + security + eval pass that the catalog publish gate runs
nv-base validate --external skills/cufolio
```

Per the publishing guide, evaluate **with and without** the skill on **both Claude Code and Codex**,
then compare. NV-BASE emits the five evaluators — `skill_execution`, `skill_efficiency`, `accuracy`,
`goal_accuracy`, `behavior_check` — which roll up into the five dimensions (Security, Correctness,
Discoverability, Effectiveness, Efficiency). Paste/auto-fill the results into `../BENCHMARK.md`.

## Notes

- Keep this CI-gated set small (P0). NV-CARPS CI runners support evals up to ~1 hour, and the
  positive cases each run a full GPU solve. The publish gate runs `evals.json` (4 cases); the
  full `evals-full.json` (9 cases) is for the longer nightly/manual run. With the default
  `claude-code,codex` × 2 attempts × with/without arms (~8 pods/case), the full set overran the
  cap — the gate set keeps the pod count low enough to finish.
- The positive cases download S&P 500 prices on first run. If a sandboxed runner has no network,
  use the guide's `evals/files/` mechanism to stage a small price CSV (not shipped here — the
  eval host is expected to install `cufolio` and have network/data access).
- Negative cases need neither GPU nor data — they only check that the skill does not misfire.
