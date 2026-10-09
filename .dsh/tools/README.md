<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E Investigation Tools

These project-scoped DSH tools separate evidence collection from causal analysis. Each directory contains the authoritative source-first `index.ts` definition that `dsh-tool-authoring` loads.

## Pattern

1. `github_actions_run_summary` normalizes one run and its jobs.
2. `github_actions_run_diff` compares two runs by exact job name.
3. `github_actions_failure_evidence` extracts bounded, redacted log signatures.
4. `git_tested_commit_range` lists commits and files between tested revisions.
5. `e2e_root_cause_correlator` groups shared signatures and checks relevant path overlap.
6. `e2e_investigation_report` renders proven facts, supported hypotheses, missing evidence, and next steps.

The first four tools collect deterministic evidence. The correlator provides a bounded first classification, not a final causal judgment. An agent must review the evidence before it adds `proven`, `hypothesis`, `notVerified`, and `nextSteps` fields to the report input.

## Example sequence

```ts
const diff = await tools.github_actions_run_diff({
  workdir: "/path/to/NemoClaw",
  repository: "NVIDIA/NemoClaw",
  earlierRunId: 32500184982,
  recentRunId: 32523257489,
});

const range = await tools.git_tested_commit_range({
  workdir: "/path/to/NemoClaw",
  earlierSha: diff.earlier.headSha,
  recentSha: diff.recent.headSha,
});

if (!range.ancestor) {
  throw new Error("The tested commit range diverges and cannot be correlated");
}

const failures = [];
for (const job of diff.newlyFailing) {
  const evidence = await tools.github_actions_failure_evidence({
    workdir: "/path/to/NemoClaw",
    repository: "NVIDIA/NemoClaw",
    runId: diff.recent.id,
    jobId: job.recentJobId,
  });
  failures.push({
    jobName: job.name,
    jobId: job.recentJobId,
    signatureLines: evidence.signatureLines,
  });
}

const correlation = await tools.e2e_root_cause_correlator({
  failures,
  changedFiles: range.changedFiles,
});

const report = await tools.e2e_investigation_report({
  repository: "NVIDIA/NemoClaw",
  earlier: diff.earlier,
  recent: diff.recent,
  range: {
    ancestor: range.ancestor,
    commitsTruncated: range.commitsTruncated,
    filesTruncated: range.filesTruncated,
  },
  commits: range.commits,
  groups: correlation.groups,
});
```

Add `relevantPaths` to each failure before correlation when repository knowledge identifies the owning source paths. Without those paths, a single-failure no-overlap result has low confidence. The report marks the investigation as incomplete when the commit or changed-file list is truncated. Do not claim causal completeness or absence of path overlap from a truncated range.

## CI failure classification

The CI failure classifier moved to the user-invocable `nemoclaw-maintainer-classify-ci-failure` skill. Its standalone Node script uses authenticated GitHub reads and performs no GitHub writes. Load the skill for usage, bounds, ZIP security, redaction, and output behavior.

## CI performance analysis

The CLI timing and base-image publication analyzers moved to the lazily loaded `nemoclaw-maintainer-analyze-ci-performance` skill. Load that skill for the standalone Node commands, bounds, output contracts, and retained-artifact requirements.

The scripts are under `.agents/skills/nemoclaw-maintainer-analyze-ci-performance/scripts/`. They use authenticated GitHub reads and perform no GitHub writes.

## Pull request value stream

The pull request value-stream analyzer moved to the lazily loaded `nemoclaw-maintainer-analyze-pr-value-stream` skill. Load that skill for the standalone Node command, comparison options, output contract, artifact validation, and caveats.

The script is `.agents/skills/nemoclaw-maintainer-analyze-pr-value-stream/scripts/analyze-pr-value-stream.mts`. It uses authenticated `gh` reads. It performs no GitHub writes.
