---
name: nemoclaw-maintainer-analyze-pr-value-stream
description: Analyze one NemoClaw pull request from its earliest observable branch push through merge. Separates approval delay from automation time and compares the latest revision with a target. Use for PR latency, value-stream, bottleneck, or ten-minute-target analysis.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Analyze a Pull Request Value Stream

Run the deterministic read-only analyzer for one pull request. The analyzer uses authenticated GitHub reads and emits bounded JSON.

## Prerequisites

- Run from a NemoClaw checkout with authenticated `gh` access.
- Use Node.js 22.19 or later with type stripping enabled.
- Retained Vitest artifact timing is conditional: install this checkout’s dependencies so `node_modules/vitest/vitest.mjs` is available, and install `zipinfo` and `unzip`. The analyzer still returns the bounded report when these optional tools or an artifact are unavailable, with the failure recorded in `caveats`.

## Run the analysis

Use the default ten-minute target:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-analyze-pr-value-stream/scripts/analyze-pr-value-stream.mts \
  --workdir "$PWD" \
  --number <pull-request-number>
```

The default repository is `NVIDIA/NemoClaw`. Use `--repository OWNER/REPO` only when the user requests another repository.

Use these comparison-friendly options. Keep every option equal when comparing pull requests:

| Option | Default | Accepted value |
|---|---:|---:|
| `--target-minutes` | `10` | Greater than 0, at most 1440 |
| `--max-run-pages` | `3` | Integer from 1 through 10 |
| `--max-check-pages` | `3` | Integer from 1 through 10 |
| `--max-automation-runs` | `50` | Integer from 1 through 100 |
| `--max-test-artifacts` | `12` | Integer from 0 through 24 |
| `--top-tests-per-shard` | `10` | Integer from 1 through 25 |

Use `--max-test-artifacts 0` to skip artifact downloads.

## Interpret the result

Report these fields first:

1. `target.status` and `target.theoreticalFastestSeconds`.
2. The largest entries in `bottlenecks`.
3. `elapsed.approvalDelaySeconds` and `elapsed.mergeLagAfterReadySeconds`.
4. `waterfall.runsTruncated` and all applicable `caveats`.

Do not describe a fallback branch timestamp as exact. Do not claim causal attribution from the counterfactual approval calculation. A truncated run set is incomplete evidence. Treat null timing fields as queued or otherwise not yet observed. Treat artifact failure caveats as status evidence, not test timing evidence.

## Trust boundaries

The script performs no GitHub writes. It invokes executables with argument arrays and rejects unknown or duplicate options. It bounds GitHub output, pagination, job counts, artifact sizes, extracted data, and final JSON.

When retained CLI shard artifacts are enabled, the script accepts only an exact run and commit match, one regular `blob-*.json` ZIP entry, and bounded compressed and expanded sizes. It uses a private temporary directory and removes that directory after the attempt.
