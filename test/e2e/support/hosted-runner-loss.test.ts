// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  hasTrustedHostedRunnerLossMarker,
  validateWorkflowJobsPage,
  verifiedRunnerLossEvidence,
  type WorkflowJob,
} from "../../../tools/e2e/hosted-runner-loss.mts";
import { detectRunnerLoss } from "../../../tools/e2e/runner-pressure-core.mts";

function lostRunnerJob(overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    id: 7,
    name: "rebuild-hermes",
    status: "completed",
    conclusion: "failure",
    runnerId: 9,
    runnerName: "GitHub Actions 42",
    labels: ["ubuntu-latest"],
    steps: [
      { name: "Prepare", status: "completed", conclusion: "success" },
      { name: "Run live test", status: "in_progress", conclusion: null },
      { name: "Upload artifacts", status: "pending", conclusion: null },
    ],
    ...overrides,
  };
}

describe("hosted-runner-loss workflow evidence (#7146)", () => {
  it("normalizes the exact GitHub job fields consumed by the classifier", () => {
    expect(
      validateWorkflowJobsPage({
        total_count: 1,
        jobs: [
          {
            id: 7,
            name: "rebuild-hermes",
            status: "completed",
            conclusion: "failure",
            runner_id: 9,
            runner_name: "GitHub Actions 42",
            labels: ["ubuntu-latest"],
            steps: [{ name: "Run live test", status: "in_progress", conclusion: null }],
          },
        ],
      }),
    ).toEqual({ totalCount: 1, jobs: [lostRunnerJob({ steps: [lostRunnerJob().steps[1]!] })] });
  });

  it("accepts one stranded active step only on a GitHub-hosted runner", () => {
    expect(hasTrustedHostedRunnerLossMarker(lostRunnerJob())).toBe(true);
    expect(
      hasTrustedHostedRunnerLossMarker(
        lostRunnerJob({ labels: ["self-hosted", "linux"], runnerName: "gpu-runner" }),
      ),
    ).toBe(false);
    expect(
      hasTrustedHostedRunnerLossMarker(
        lostRunnerJob({
          steps: [
            { name: "First", status: "in_progress", conclusion: null },
            { name: "Second", status: "in_progress", conclusion: null },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects an ordinary failed step even when hosted-runner metadata is present", () => {
    expect(
      hasTrustedHostedRunnerLossMarker(
        lostRunnerJob({
          steps: [{ name: "Assertion", status: "completed", conclusion: "failure" }],
        }),
      ),
    ).toBe(false);
  });

  it("fails closed when runner loss and an ordinary failure coexist", () => {
    const evidence = verifiedRunnerLossEvidence({
      workflowConclusion: "failure",
      jobs: [
        lostRunnerJob(),
        lostRunnerJob({
          id: 8,
          name: "full-e2e",
          steps: [{ name: "Assertion", status: "completed", conclusion: "failure" }],
        }),
      ],
      jobDetailsAvailable: true,
      jobDetailsComplete: true,
    });

    expect(evidence).toEqual({
      jobConclusion: "failure",
      runnerLostMarkerCount: 1,
      terminalClassificationPresent: true,
    });
    expect(detectRunnerLoss(evidence!)).toBe(false);
  });

  it("treats a timed-out job beside runner loss as a mixed failure", () => {
    const evidence = verifiedRunnerLossEvidence({
      workflowConclusion: "failure",
      jobs: [
        lostRunnerJob(),
        lostRunnerJob({
          id: 8,
          name: "timed-out-job",
          conclusion: "timed_out",
          steps: [{ name: "Run tests", status: "completed", conclusion: "timed_out" }],
        }),
      ],
      jobDetailsAvailable: true,
      jobDetailsComplete: true,
    });

    expect(evidence?.terminalClassificationPresent).toBe(true);
    expect(detectRunnerLoss(evidence!)).toBe(false);
  });

  it("rejects a cancelled workflow even when a job has the runner-loss marker", () => {
    expect(
      verifiedRunnerLossEvidence({
        workflowConclusion: "cancelled",
        jobs: [
          lostRunnerJob(),
          lostRunnerJob({
            id: 8,
            name: "cancelled-job",
            conclusion: "cancelled",
            steps: [{ name: "Run tests", status: "completed", conclusion: "cancelled" }],
          }),
        ],
        jobDetailsAvailable: true,
        jobDetailsComplete: true,
      }),
    ).toBeNull();
  });

  it("requires a complete job listing before confirming runner loss", () => {
    expect(
      verifiedRunnerLossEvidence({
        workflowConclusion: "failure",
        jobs: [lostRunnerJob()],
        jobDetailsAvailable: true,
        jobDetailsComplete: false,
      }),
    ).toBeNull();
  });
});
