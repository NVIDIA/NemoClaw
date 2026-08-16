// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  formatReliabilityReport,
  normalizeReliabilityRun,
  type ReliabilitySample,
  summarizeReliability,
} from "../../../tools/e2e/same-commit-reliability.mts";
import { artifactZip } from "../../helpers/artifact-zip";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REPOSITORY = "NVIDIA/NemoClaw";

function sample(
  runId: number,
  candidateSha: string,
  source: ReliabilitySample["source"],
  outcome: ReliabilitySample["outcome"],
  failureClasses: ReliabilitySample["failureClasses"] = [],
): ReliabilitySample {
  return {
    runId,
    runAttempt: outcome === "passed-after-retry" || outcome === "exhausted" ? 2 : 1,
    candidateSha,
    source,
    outcome,
    failureClasses,
    evidence: "complete",
    url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
  };
}

function workflowRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    event: "workflow_dispatch",
    path: ".github/workflows/e2e.yaml",
    display_title: "E2E PR #7 (qualification)",
    head_branch: "main",
    head_sha: SHA_B,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/101`,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

describe("same-commit E2E reliability", () => {
  it("keeps commits and run sources separate while reporting recovery and flips", () => {
    const groups = summarizeReliability([
      sample(1, SHA_A, "trusted-main", "failed-first-attempt", ["assertion"]),
      sample(2, SHA_A, "trusted-main", "passed-after-retry", ["transient-external"]),
      sample(3, SHA_A, "trusted-main", "exhausted", ["timeout"]),
      sample(4, SHA_A, "trusted-main", "passed-first-attempt"),
      sample(5, SHA_A, "manual-qualification", "passed-first-attempt"),
      sample(6, SHA_B, "trusted-main", "passed-first-attempt"),
      sample(7, SHA_A, "trusted-main", "superseded"),
    ]);

    expect(groups).toHaveLength(3);
    expect(
      groups.find((group) => group.source === "trusted-main" && group.candidateSha === SHA_A),
    ).toMatchObject({
      runs: 5,
      passedFirstAttempt: 1,
      passedAfterRetry: 1,
      failedFirstAttempt: 1,
      exhausted: 1,
      superseded: 1,
      passFailFlips: 3,
      firstPassRate: 0.25,
      recoveryRate: 0.5,
      failureClasses: { assertion: 1, "transient-external": 1, timeout: 1 },
    });
  });

  it("renders only normalized identities and fixed classes, never input credentials", () => {
    const secret = "ghp_should-never-appear";
    const report = formatReliabilityReport([
      ...summarizeReliability([
        sample(1, SHA_A, "trusted-main", "failed-first-attempt", ["authentication"]),
      ]),
    ]);

    expect(report).toContain("authentication: 1");
    expect(report).toContain(SHA_A.slice(0, 12));
    expect(report).not.toContain(secret);
  });

  it("consumes dispatch, retry, and runner classifications without retaining payload text", async () => {
    const secret = "sk-live-secret-output";
    const dispatch = artifactZip([
      {
        name: "dispatch.json",
        contents: JSON.stringify({
          kind: "nemoclaw-e2e-dispatch-v2",
          repository: REPOSITORY,
          eventName: "workflow_dispatch",
          workflowRunId: "101",
          workflowRunAttempt: 1,
          candidateSha: SHA_A,
          ignoredCredential: secret,
        }),
      },
    ]);
    const evidence = artifactZip([
      {
        name: "e2e-artifacts/live/example/runner-pressure-classification.jsonl",
        contents:
          'E2E_TERMINAL_CLASSIFICATION {"v":1,"classification":"timeout","reason":"phase timed out"}\n',
      },
      {
        name: "e2e-artifacts/live/example/retry/provider.json",
        contents: JSON.stringify({
          schemaVersion: 1,
          operation: "provider.readiness",
          owner: "provider",
          idempotence: "read-only",
          maxAttempts: 2,
          outcome: "exhausted",
          attempts: [
            {
              attempt: 1,
              outcome: "failed",
              failureClass: "transient-external",
              retryScheduled: true,
            },
            {
              attempt: 2,
              outcome: "failed",
              failureClass: "transient-external",
              retryScheduled: false,
            },
          ],
          ignoredCredential: secret,
        }),
      },
    ]);
    const archives = new Map([
      [1, dispatch],
      [2, evidence],
    ]);
    const result = await normalizeReliabilityRun(workflowRun(), {
      requestJson: async () => ({
        total_count: 2,
        artifacts: [
          {
            id: 1,
            name: "e2e-dispatch-101-1",
            size_in_bytes: dispatch.length,
            expired: false,
          },
          {
            id: 2,
            name: "e2e-example",
            size_in_bytes: evidence.length,
            expired: false,
          },
        ],
      }),
      requestArchive: async (artifactId) => archives.get(artifactId)!,
    });

    expect(result).toMatchObject({
      candidateSha: SHA_A,
      source: "manual-qualification",
      outcome: "failed-first-attempt",
      failureClasses: ["timeout", "transient-external"],
      evidence: "complete",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("keeps missing or malformed manual identity evidence unclassified", async () => {
    const missing = await normalizeReliabilityRun(workflowRun({ conclusion: "success" }), {
      requestJson: async () => ({ total_count: 0, artifacts: [] }),
      requestArchive: async () => Buffer.alloc(0),
    });
    expect(missing).toMatchObject({
      candidateSha: null,
      outcome: "unclassified",
      evidence: "missing",
    });
    expect(summarizeReliability([missing!])).toEqual([
      expect.objectContaining({ candidateSha: null, runs: 1, unclassified: 1 }),
    ]);

    const malformedZip = artifactZip([{ name: "dispatch.json", contents: "{}" }]);
    const malformed = await normalizeReliabilityRun(workflowRun({ conclusion: "success" }), {
      requestJson: async () => ({
        total_count: 1,
        artifacts: [
          {
            id: 9,
            name: "e2e-dispatch-101-1",
            size_in_bytes: malformedZip.length,
            expired: false,
          },
        ],
      }),
      requestArchive: async () => malformedZip,
    });
    expect(malformed).toMatchObject({
      candidateSha: null,
      outcome: "unclassified",
      evidence: "malformed",
    });
  });
});
