// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { verifiedRunnerLossEvidence } from "../tools/e2e/pr-e2e-gate.mts";
import { detectRunnerLoss } from "../tools/e2e/runner-pressure-core.mts";

function hostedRunnerLossJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 89_074_697_099,
    name: "Hermes security-posture",
    status: "completed",
    conclusion: "failure",
    runnerId: 1_021_277_393,
    runnerName: "GitHub Actions 1021277393",
    runnerGroupId: 0,
    runnerGroupName: "GitHub Actions",
    labels: ["ubuntu-latest"],
    steps: [
      { name: "Set up job", status: "completed", conclusion: "success" },
      {
        name: "Run security posture live Vitest test",
        status: "completed",
        conclusion: "cancelled",
      },
      { name: "Upload security posture artifacts", status: "completed", conclusion: "skipped" },
      { name: "Clean up Docker auth", status: "completed", conclusion: "skipped" },
      { name: "Complete job", status: "completed", conclusion: "success" },
    ],
    ...overrides,
  };
}

function legacyHostedRunnerLossJob(id: number, runnerId: number) {
  return hostedRunnerLossJob({
    id,
    runnerId,
    runnerName: `GitHub Actions ${runnerId}`,
    steps: [
      { name: "Set up job", status: "completed", conclusion: "success" },
      { name: "Run live test", status: "in_progress", conclusion: null },
      { name: "Upload artifacts", status: "pending", conclusion: null },
    ],
  });
}

function confirmsRunnerLoss(
  options: {
    workflowConclusion?: string;
    jobs?: ReturnType<typeof hostedRunnerLossJob>[];
    complete?: boolean;
  } = {},
): boolean {
  const evidence = verifiedRunnerLossEvidence({
    workflowConclusion: options.workflowConclusion ?? "failure",
    jobs: options.jobs ?? [hostedRunnerLossJob()],
    jobDetailsAvailable: true,
    jobDetailsComplete: options.complete ?? true,
  });
  return evidence === null ? false : detectRunnerLoss(evidence);
}

describe("PR E2E hosted-runner-loss classifier", () => {
  it("accepts the terminalized GitHub-hosted shutdown shape from run 29965049603", () => {
    expect(confirmsRunnerLoss()).toBe(true);
  });

  it("accepts two strict standard-hosted legacy markers from run 29964500642", () => {
    expect(
      confirmsRunnerLoss({
        jobs: [
          legacyHostedRunnerLossJob(89_073_235_001, 1_021_276_370),
          legacyHostedRunnerLossJob(89_073_235_002, 1_021_276_371),
        ],
      }),
    ).toBe(true);
  });

  it.each([
    {
      label: "the workflow is cancelled",
      options: { workflowConclusion: "cancelled" },
    },
    {
      label: "the workflow times out",
      options: { workflowConclusion: "timed_out" },
    },
    {
      label: "another selected job is cancelled",
      options: {
        jobs: [
          hostedRunnerLossJob(),
          hostedRunnerLossJob({ id: 2, name: "other", conclusion: "cancelled", steps: [] }),
        ],
      },
    },
    {
      label: "another selected job times out",
      options: {
        jobs: [
          hostedRunnerLossJob(),
          hostedRunnerLossJob({ id: 2, name: "other", conclusion: "timed_out", steps: [] }),
        ],
      },
    },
    {
      label: "the synthetic completion is not last",
      options: {
        jobs: [
          hostedRunnerLossJob({
            steps: [
              ...hostedRunnerLossJob().steps,
              { name: "Post cleanup", status: "completed", conclusion: "skipped" },
            ],
          }),
        ],
      },
    },
    {
      label: "two workload steps are cancelled",
      options: {
        jobs: [
          hostedRunnerLossJob({
            steps: [
              { name: "Set up job", status: "completed", conclusion: "success" },
              { name: "First workload", status: "completed", conclusion: "cancelled" },
              { name: "Second workload", status: "completed", conclusion: "cancelled" },
              { name: "Cleanup", status: "completed", conclusion: "skipped" },
              { name: "Complete job", status: "completed", conclusion: "success" },
            ],
          }),
        ],
      },
    },
    {
      label: "a prior step failed",
      options: {
        jobs: [
          hostedRunnerLossJob({
            steps: [
              { name: "Set up job", status: "completed", conclusion: "failure" },
              ...hostedRunnerLossJob().steps.slice(1),
            ],
          }),
        ],
      },
    },
    {
      label: "no cleanup step is skipped",
      options: {
        jobs: [
          hostedRunnerLossJob({
            steps: [
              { name: "Set up job", status: "completed", conclusion: "success" },
              { name: "Workload", status: "completed", conclusion: "cancelled" },
              { name: "Complete job", status: "completed", conclusion: "success" },
            ],
          }),
        ],
      },
    },
    {
      label: "cleanup succeeds",
      options: {
        jobs: [
          hostedRunnerLossJob({
            steps: hostedRunnerLossJob().steps.map((step) =>
              step.name === "Clean up Docker auth" ? { ...step, conclusion: "success" } : step,
            ),
          }),
        ],
      },
    },
    {
      label: "skipped cleanup remains pending",
      options: {
        jobs: [
          hostedRunnerLossJob({
            steps: hostedRunnerLossJob().steps.map((step) =>
              step.name === "Clean up Docker auth" ? { ...step, status: "pending" } : step,
            ),
          }),
        ],
      },
    },
    {
      label: "the runner is self-hosted",
      options: { jobs: [hostedRunnerLossJob({ labels: ["self-hosted", "linux"] })] },
    },
    {
      label: "a standard-looking runner belongs to a custom group",
      options: {
        jobs: [hostedRunnerLossJob({ runnerGroupId: 7, runnerGroupName: "larger-runner-pool" })],
      },
    },
    {
      label: "a custom-label runner omits self-hosted",
      options: {
        jobs: [
          hostedRunnerLossJob({
            runnerName: "ubuntu-latest-4-cores-1234",
            runnerGroupId: 7,
            runnerGroupName: "larger-runner-pool",
            labels: ["ubuntu-latest-4-cores"],
          }),
        ],
      },
    },
    {
      label: "the jobs listing is incomplete",
      options: { complete: false },
    },
    {
      label: "a legacy successful step is still pending",
      options: {
        jobs: [
          hostedRunnerLossJob({
            steps: [
              { name: "Set up job", status: "pending", conclusion: "success" },
              { name: "Workload", status: "in_progress", conclusion: null },
            ],
          }),
        ],
      },
    },
    {
      label: "a legacy run completes a later synthetic step",
      options: {
        jobs: [
          hostedRunnerLossJob({
            steps: [
              { name: "Set up job", status: "completed", conclusion: "success" },
              { name: "Workload", status: "in_progress", conclusion: null },
              { name: "Complete job", status: "completed", conclusion: "success" },
            ],
          }),
        ],
      },
    },
  ])("rejects runner loss when $label", ({ options }) => {
    expect(confirmsRunnerLoss(options)).toBe(false);
  });
});
