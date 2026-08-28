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

## Pull request value stream

Use `analyze_pr_value_stream` to measure one pull request from the earliest observable branch push through merge:

```ts
const valueStream = await tools.analyze_pr_value_stream({
  workdir: "/path/to/NemoClaw",
  number: 10301,
  targetMinutes: 10,
  maxTestArtifacts: 12,
  topTestsPerShard: 10,
});
```

The report separates these intervals:

- Branch push to pull request open.
- Pull request open to the latest revision.
- Latest revision to selected automation completion.
- Approval delay after automation.
- Ready-to-merge lag.

The `waterfall` field contains chart-ready timing data for each retained exact-head GitHub Actions run, its jobs, and each job's steps. Every row includes absolute timestamps and an offset from the latest-revision origin. Workflow and job rows also separate observed queue time from execution time. Use `maxAutomationRuns` to lower the default 50-run bound; the report states when it truncates runs and rejects workflows with more than 100 jobs rather than returning a partial graph.

Jobs named exactly `cli-test-shards (1)` through `cli-test-shards (12)` can also include a nullable `testRun`. The tool lists each eligible run's artifacts once, then merges the matching `cli-blob-report-N` with the checkout's pinned Vitest. The result reports test and file counts, the timed interval, and the slowest tests. `maxTestArtifacts` defaults to 12 and accepts 0 through 24; 0 disables artifact downloads. `topTestsPerShard` defaults to 10 and accepts 1 through 25. Missing, expired, duplicate, oversized, or invalid artifacts leave `testRun` null without interrupting the pull request analysis.

The target result models a one-push pull request with immediate opening and approval. It uses the latest revision's observed automation time plus the observed ready-to-merge lag. GitHub does not expose a canonical branch-created time, so the report identifies whether the start came from a retained push run or a lower-confidence fallback. Treat one pull request as a diagnostic sample, not a service-level distribution.

## Trust boundaries

- The tools use authenticated `gh` and local `git`; they make no GitHub writes.
- Job logs are untrusted input. The evidence tool returns bounded excerpts and redacts common credential forms.
- The value-stream tool downloads only exact CLI shard blob-report artifacts. It validates artifact and ZIP metadata, run identity, head commit, compressed and expanded size limits, and the single safe entry name. It extracts into a private temporary directory, bounds returned text, and removes temporary files on exit.
- Exact job-name comparison is intentional. A future stable target-identity resolver must use repository-owned matrix metadata rather than fuzzy matching.

## Activation

The Web profile must include the `dsh-tool-authoring` bundle. Restart the DSH Web process after changing the profile so the server registers `tool_define`, `tool_list`, `tool_remove`, `tool_promote`, and the project tools. Starting a second Web server does not update the existing GUI.
