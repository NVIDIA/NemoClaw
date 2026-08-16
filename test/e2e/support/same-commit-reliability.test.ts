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
import { readYaml, type WorkflowJob, type WorkflowStep } from "../../helpers/e2e-workflow-contract";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REPOSITORY = "NVIDIA/NemoClaw";
const RETRY_WORKFLOW_PATH = ".github/workflows/e2e-main-retry.yaml";

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
    failureClassEvidence: failureClasses.length > 0 ? "complete" : "missing",
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

function controllerRun(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "in_progress",
    event: "workflow_run",
    path: RETRY_WORKFLOW_PATH,
    head_branch: "main",
    head_sha: SHA_A,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${id}`,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function retryEvidence(runId: number, sourceSha: string): Buffer {
  return artifactZip([
    {
      name: "e2e-main-retry-evidence.json",
      contents: JSON.stringify({
        schemaVersion: 1,
        sourceRunId: runId,
        sourceSha,
        sourceAttempt: 1,
        action: "passed-first-attempt",
        reason: "source run passed",
      }),
    },
  ]);
}

function terminalEvidence(
  candidateSha: string,
  jobStatus: "failure" | "success",
): { name: string; contents: string } {
  return {
    name: "e2e-artifacts/live/example/evidence-manifest.json",
    contents: JSON.stringify({
      kind: "nemoclaw-e2e-evidence-v1",
      targetId: "example",
      candidate: { repository: REPOSITORY, sha: candidateSha },
      workflow: {
        repository: REPOSITORY,
        sha: SHA_B,
        runId: "101",
        runAttempt: "1",
        jobStatus,
      },
      artifactDirectory: "e2e-artifacts/live/example",
      productEvidenceFileCount: 1,
    }),
  };
}

function mappedRequest(entries: ReadonlyArray<readonly [string, unknown]>) {
  const responses = new Map(entries);
  return async (path: string): Promise<unknown> => {
    expect(responses.has(path), `unexpected path ${path}`).toBe(true);
    return responses.get(path);
  };
}

function workflowStep(job: WorkflowJob, name: string): WorkflowStep {
  const found = job.steps?.find((step) => step.name === name);
  expect(found, `missing workflow step ${name}`).toBeDefined();
  return found!;
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
        sample(1, SHA_A, "trusted-main", "failed-first-attempt", [
          "authentication",
          secret as ReliabilitySample["failureClasses"][number],
        ]),
      ]),
    ]);

    expect(report).toContain("authentication: 1");
    expect(report).toContain(SHA_A.slice(0, 12));
    expect(report).not.toContain(secret);
  });

  // source-shape-contract: security -- The reliability reporter must execute only from the trusted default-branch controller while authenticating the canonical E2E source repository and branch
  it("locks the reporter to canonical source and trusted controller identities (#9168)", () => {
    type RetryWorkflow = {
      jobs: { "report-same-commit-reliability": WorkflowJob };
    };
    const reporter =
      readYaml<RetryWorkflow>(RETRY_WORKFLOW_PATH).jobs["report-same-commit-reliability"];
    const guard = reporter.if ?? "";
    for (const fragment of [
      "github.repository == 'NVIDIA/NemoClaw'",
      "github.event.workflow_run.path == '.github/workflows/e2e.yaml'",
      "github.event.workflow_run.head_branch == 'main'",
      "github.event.workflow_run.head_repository.full_name == 'NVIDIA/NemoClaw'",
    ]) {
      expect(guard).toContain(fragment);
    }
    expect(workflowStep(reporter, "Checkout trusted reliability reporter").with).toEqual({
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
    });
    const build = workflowStep(reporter, "Build advisory same-commit reliability report");
    expect(build.env).toEqual({
      GITHUB_TOKEN: "${{ github.token }}",
      SOURCE_RUN_ID: "${{ github.event.workflow_run.id }}",
    });
    expect(build.run).toContain('>"${RUNNER_TEMP}/same-commit-reliability.json"');
    expect(build.run).toContain('2>"${RUNNER_TEMP}/same-commit-reliability.md"');
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
      terminalEvidence(SHA_A, "failure"),
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
      failureClassEvidence: "complete",
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

  it("requires terminal evidence after authenticating a manual dispatch", async () => {
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
        }),
      },
    ]);
    const result = await normalizeReliabilityRun(workflowRun({ conclusion: "success" }), {
      requestJson: async () => ({
        total_count: 1,
        artifacts: [
          {
            id: 1,
            name: "e2e-dispatch-101-1",
            size_in_bytes: dispatch.length,
            expired: false,
          },
        ],
      }),
      requestArchive: async () => dispatch,
    });

    expect(result).toMatchObject({
      candidateSha: SHA_A,
      source: "manual-qualification",
      outcome: "unclassified",
      evidence: "missing",
    });
    expect(summarizeReliability([result!])[0]).toMatchObject({
      passedFirstAttempt: 0,
      unclassified: 1,
    });
  });

  it("accepts authenticated terminal evidence for a passing manual run", async () => {
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
        }),
      },
    ]);
    const terminal = artifactZip([terminalEvidence(SHA_A, "success")]);
    const archives = new Map([
      [1, dispatch],
      [2, terminal],
    ]);
    const result = await normalizeReliabilityRun(workflowRun({ conclusion: "success" }), {
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
            size_in_bytes: terminal.length,
            expired: false,
          },
        ],
      }),
      requestArchive: async (artifactId) => archives.get(artifactId)!,
    });

    expect(result).toMatchObject({
      candidateSha: SHA_A,
      source: "manual-qualification",
      outcome: "passed-first-attempt",
      evidence: "complete",
      failureClassEvidence: "missing",
    });
  });

  it("reports malformed failure-class evidence without discarding a terminal outcome", async () => {
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
        }),
      },
    ]);
    const terminal = artifactZip([
      terminalEvidence(SHA_A, "success"),
      {
        name: "e2e-artifacts/live/example/retry/provider.json",
        contents: "{}",
      },
    ]);
    const archives = new Map([
      [1, dispatch],
      [2, terminal],
    ]);
    const result = await normalizeReliabilityRun(workflowRun({ conclusion: "success" }), {
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
            size_in_bytes: terminal.length,
            expired: false,
          },
        ],
      }),
      requestArchive: async (artifactId) => archives.get(artifactId)!,
    });

    expect(result).toMatchObject({
      outcome: "passed-first-attempt",
      evidence: "complete",
      failureClassEvidence: "malformed",
    });
    const groups = summarizeReliability([result!]);
    expect(groups[0]).toMatchObject({
      evidence: { complete: 1, malformed: 0, missing: 0 },
      failureClassEvidence: { complete: 0, malformed: 1, missing: 0 },
    });
    expect(formatReliabilityReport(groups)).toContain("complete: 0, malformed: 1, missing: 0");
  });

  it("accepts trusted-main evidence only from the canonical retry controller", async () => {
    const archive = retryEvidence(101, SHA_B);
    const name = "e2e-main-retry-101-1";
    const result = await normalizeReliabilityRun(
      workflowRun({
        event: "push",
        conclusion: "success",
        display_title: "E2E main",
      }),
      {
        requestJson: mappedRequest([
          [
            `repos/${REPOSITORY}/actions/runs/101/artifacts?per_page=100`,
            { total_count: 0, artifacts: [] },
          ],
          [
            `repos/${REPOSITORY}/actions/artifacts?name=${name}&per_page=100`,
            {
              total_count: 1,
              artifacts: [
                {
                  id: 7,
                  name,
                  size_in_bytes: archive.length,
                  expired: false,
                  workflow_run: { id: 202 },
                },
              ],
            },
          ],
          [`repos/${REPOSITORY}/actions/runs/202`, controllerRun(202)],
        ]),
        requestArchive: async () => archive,
      },
    );

    expect(result).toMatchObject({
      candidateSha: SHA_B,
      source: "trusted-main",
      outcome: "passed-first-attempt",
      evidence: "complete",
    });
  });

  it("rejects trusted-main evidence from an untrusted workflow", async () => {
    const archive = retryEvidence(101, SHA_B);
    const name = "e2e-main-retry-101-1";
    const result = await normalizeReliabilityRun(
      workflowRun({
        event: "push",
        conclusion: "success",
        display_title: "E2E main",
      }),
      {
        requestJson: mappedRequest([
          [
            `repos/${REPOSITORY}/actions/runs/101/artifacts?per_page=100`,
            { total_count: 0, artifacts: [] },
          ],
          [
            `repos/${REPOSITORY}/actions/artifacts?name=${name}&per_page=100`,
            {
              total_count: 1,
              artifacts: [
                {
                  id: 8,
                  name,
                  size_in_bytes: archive.length,
                  expired: false,
                  workflow_run: { id: 203 },
                },
              ],
            },
          ],
          [
            `repos/${REPOSITORY}/actions/runs/203`,
            controllerRun(203, { path: ".github/workflows/other.yaml" }),
          ],
        ]),
        requestArchive: async () => archive,
      },
    );

    expect(result).toMatchObject({
      candidateSha: SHA_B,
      source: "trusted-main",
      outcome: "unclassified",
      evidence: "malformed",
    });
  });

  it("fails closed when trusted-main artifact names collide", async () => {
    const archive = retryEvidence(101, SHA_B);
    const name = "e2e-main-retry-101-1";
    const result = await normalizeReliabilityRun(
      workflowRun({
        event: "push",
        conclusion: "success",
        display_title: "E2E main",
      }),
      {
        requestJson: mappedRequest([
          [
            `repos/${REPOSITORY}/actions/runs/101/artifacts?per_page=100`,
            { total_count: 0, artifacts: [] },
          ],
          [
            `repos/${REPOSITORY}/actions/artifacts?name=${name}&per_page=100`,
            {
              total_count: 2,
              artifacts: [202, 203].map((controllerId) => ({
                id: controllerId,
                name,
                size_in_bytes: archive.length,
                expired: false,
                workflow_run: { id: controllerId },
              })),
            },
          ],
        ]),
        requestArchive: async () => archive,
      },
    );

    expect(result).toMatchObject({
      candidateSha: SHA_B,
      source: "trusted-main",
      outcome: "unclassified",
      evidence: "malformed",
    });
  });
});
