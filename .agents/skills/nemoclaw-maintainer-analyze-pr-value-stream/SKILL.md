---
name: nemoclaw-maintainer-analyze-pr-value-stream
description: Analyze one NemoClaw pull request across its complete observable lifetime. Produces a bounded Perfetto trace and summary, separates contributor, review, and automation time, and compares the latest revision with a target. Use for PR latency, value-stream, bottleneck, timeline, or ten-minute-target analysis.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Analyze a Pull Request Value Stream

Run the deterministic read-only analyzer once for one pull request. Every invocation collects the complete observable retained lifetime. It writes a Perfetto-compatible trace, summary, and manifest under `.nemoclaw-maintainer/pr-value-stream/pr-<number>/` and emits the summary as bounded JSON on stdout.

Do not run a reduced or latest-revision-only analysis. The latest-revision waterfall remains one derived part of the complete lifetime result.

## Prerequisites

- Run from a NemoClaw checkout with authenticated `gh` access.
- Use Node.js 22.19 or later with type stripping enabled.
- Retained Vitest artifact timing is conditional: install this checkout's dependencies so `node_modules/vitest/vitest.mjs` is available, and install `zipinfo` and `unzip`. Optional artifact failures appear in `caveats` and do not become test-timing evidence.

## Run the analysis

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-analyze-pr-value-stream/scripts/analyze-pr-value-stream.mts \
  --workdir "$PWD" \
  --number <pull-request-number>
```

The default repository is `NVIDIA/NemoClaw`. Use `--repository OWNER/REPO` only when the user requests another repository. The ten-minute target defaults to 10; use `--target-minutes` only when the user requests another target.

The analyzer owns completeness and safety bounds. Do not use legacy pagination or truncation options to reduce the standard analysis. If required retained history exceeds a bound, the command fails rather than calling a partial trace complete.

## Outputs

A successful invocation writes:

- `summary.json`: the complete bounded value-stream report printed on stdout.
- `trace.json`: Chrome Trace Event JSON for Perfetto or `chrome://tracing`.
- `manifest.json`: exact pull request identity, head commit, output sizes, and completeness declarations. This file is written last.

The trace contains lifecycle events, all retained PR revisions, workflows, job queues, job executions, steps, external checks, reviews, comments, inline feedback, commit publication spans, and temporal feedback-to-next-change spans.

Open `trace.json` in Perfetto to zoom, filter categories, inspect event arguments, and measure arbitrary intervals.

## Interpret the result

Report these fields first:

1. `target.status` and `target.theoreticalFastestSeconds`.
2. The largest entries in `bottlenecks`.
3. `elapsed.approvalDelaySeconds` and `elapsed.mergeLagAfterReadySeconds`.
4. The `lifetime` artifact paths and counts.
5. All applicable `caveats`.

Do not describe a fallback branch timestamp as exact. Do not claim causal attribution from temporal feedback-to-change spans or counterfactual approval calculations. Treat null timing fields as queued or otherwise unobserved. Treat artifact failure caveats as status evidence, not test timing evidence.

## Trust boundaries

The script performs no GitHub writes. It invokes executables with argument arrays, bounds GitHub output, pagination, revisions, workflow runs, jobs, trace events, artifact sizes, and file sizes, and rejects malformed or incomplete required history. Lifetime artifact publication uses a per-PR lock. An active publication waits for up to 30 seconds; a lock left untouched for more than five minutes is reclaimed when its recorded owner identity no longer matches, when owner metadata is unreadable, or when the host cannot provide a process-start identity. A timeout reports the exact active lock path for diagnosis.

GitHub does not expose canonical branch-creation timestamps or pull request description edit history. The trace uses the first retained exact-commit workflow as an observable push signal and records that limitation. Draft transitions appear only when GitHub's timeline returns them.

When retained CLI shard artifacts are available, the script accepts only an exact run and commit match, one regular `blob-*.json` ZIP entry, and bounded compressed and expanded sizes. It uses a private temporary directory and removes it after the attempt.
