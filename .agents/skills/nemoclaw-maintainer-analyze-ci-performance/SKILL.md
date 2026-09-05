---
name: nemoclaw-maintainer-analyze-ci-performance
description: Analyze retained NemoClaw CI timing evidence for slow CLI tests or base-image publication latency. Use for CI performance, slow tests, Vitest timing artifacts, base-image publication timing, runner queue latency, or publication-gate analysis.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Analyze CI Performance

Run one read-only standalone analyzer from a NemoClaw checkout. Both commands use authenticated `gh` reads and print bounded JSON to stdout. They perform no GitHub writes.

## Analyze recent CLI timings

Use retained `cli-vitest-results` artifacts to rank consistently slow tests and files. The CI workflow retains this historical input for 14 days:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-analyze-ci-performance/scripts/analyze-recent-cli-timings.mts \
  --workdir "$PWD"
```

Defaults preserve the former timing tool contract: repository `NVIDIA/NemoClaw`, 10 reports, 15 results, a 0.7 minimum sample ratio, and artifact name `cli-vitest-results`. Optional flags are `--repo`, `--limit`, `--top`, `--min-sample-ratio`, and `--artifact-name`.

The analyzer requires at least two usable retained reports. It rejects compressed artifacts above 25,000,000 bytes and bounds ZIP entries, expanded content, listings, and report content. It requires Bash, GNU `dd` and `find`, Info-ZIP `zipinfo` and `unzip`, `awk`, `base64`, `mktemp`, `stat`, and `wc` on Linux.

## Analyze base-image publication

Compare main-push E2E runs that publish a same-commit base image with runs that reuse a prior publication:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-analyze-ci-performance/scripts/analyze-base-image-publication-timings.mts \
  --workdir "$PWD"
```

Defaults preserve the former timing tool contract: repository `NVIDIA/NemoClaw`, 300 E2E runs, 500 base-image runs, and up to 150 systematic samples per stratum. Optional flags are `--repo`, `--e2e-limit`, `--base-limit`, and `--max-per-stratum`.

Report the population window and stratum sizes before statistics. Treat `atLeast30SuccessfulJobs: false` as insufficient evidence for stable inference. Job execution, verifier, workflow completion, runner queue, and matrix-boundary measurements use successful publication jobs only.

## Boundaries

Do not combine this workflow with pull request value-stream analysis. Load `nemoclaw-maintainer-analyze-pr-value-stream` for a complete PR lifetime trace. Stop on GitHub authentication or authorization failure and follow the repository GitHub access hard stop.
