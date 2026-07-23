// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { verifiedRunnerLossEvidence } from "../tools/e2e/pr-e2e-gate.mts";
import { detectRunnerLoss } from "../tools/e2e/runner-pressure-core.mts";

const WORKFLOW_SHA = "d".repeat(40);
const RUNNER_LOSS_MESSAGE =
  "The hosted runner lost communication with the server. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.";
const RUNNER_SHUTDOWN_MESSAGE =
  "The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.";
const JOB_STARTED_AT = "2026-07-23T07:26:56Z";
const CANCELLED_STEP_STARTED_AT = "2026-07-23T07:27:43Z";
const CANCELLED_STEP_COMPLETED_AT = "2026-07-23T07:32:49Z";
const COMPLETE_JOB_AT = "2026-07-23T07:32:50Z";
const JOB_COMPLETED_AT = "2026-07-23T07:32:54Z";

function runnerLossAnnotation(message = RUNNER_LOSS_MESSAGE) {
  return {
    path: ".github",
    blobHref: `https://github.com/NVIDIA/NemoClaw/blob/${WORKFLOW_SHA}/.github`,
    startLine: 1,
    startColumn: null,
    endLine: 1,
    endColumn: null,
    annotationLevel: "failure",
    title: "",
    message,
    rawDetails: "",
  };
}

function genericCancellationAnnotation() {
  return {
    ...runnerLossAnnotation("The operation was canceled."),
    startLine: 34,
    endLine: 34,
  };
}

function orphanProcessLogLine(index: number, pid = index + 1, processName = `node-${pid}`) {
  return `2026-07-23T07:32:50.${String(1_000_000 + index).padStart(
    7,
    "0",
  )}Z Terminate orphan process: pid (${pid}) (${processName})`;
}

function runnerShutdownLogTail(orphanProcessLines: string[] = []) {
  const lines = [
    `2026-07-23T07:32:47.0261924Z ##[error]${RUNNER_SHUTDOWN_MESSAGE}`,
    "2026-07-23T07:32:49.9360750Z ##[error]The operation was canceled.",
    "2026-07-23T07:32:50.0577487Z Cleaning up orphan processes",
    ...orphanProcessLines,
  ];
  return `${lines.join("\n")}\n`;
}

function runnerShutdownLogEvidence(tail = runnerShutdownLogTail()) {
  return {
    etag: '"runner-loss-log-etag"',
    totalBytes: new TextEncoder().encode(tail).byteLength,
    tail,
  };
}

function hostedRunnerLossJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 89_074_697_099,
    name: "Hermes security-posture",
    headSha: WORKFLOW_SHA,
    status: "completed",
    conclusion: "failure",
    runnerId: 1_021_277_393,
    runnerName: "GitHub Actions 1021277393",
    runnerGroupId: 0,
    runnerGroupName: "GitHub Actions",
    labels: ["ubuntu-latest"],
    annotations: [runnerLossAnnotation()],
    startedAt: JOB_STARTED_AT,
    completedAt: JOB_COMPLETED_AT,
    steps: [
      {
        name: "Set up job",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-07-23T07:26:57Z",
        completedAt: "2026-07-23T07:27:03Z",
      },
      {
        name: "Run security posture live Vitest test",
        status: "completed",
        conclusion: "cancelled",
        startedAt: CANCELLED_STEP_STARTED_AT,
        completedAt: CANCELLED_STEP_COMPLETED_AT,
      },
      {
        name: "Upload security posture artifacts",
        status: "completed",
        conclusion: "skipped",
        startedAt: CANCELLED_STEP_COMPLETED_AT,
        completedAt: CANCELLED_STEP_COMPLETED_AT,
      },
      {
        name: "Clean up Docker auth",
        status: "completed",
        conclusion: "skipped",
        startedAt: CANCELLED_STEP_COMPLETED_AT,
        completedAt: CANCELLED_STEP_COMPLETED_AT,
      },
      {
        name: "Complete job",
        status: "completed",
        conclusion: "success",
        startedAt: COMPLETE_JOB_AT,
        completedAt: COMPLETE_JOB_AT,
      },
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
    repository: "NVIDIA/NemoClaw",
    workflowSha: WORKFLOW_SHA,
    workflowConclusion: options.workflowConclusion ?? "failure",
    jobs: options.jobs ?? [hostedRunnerLossJob()],
    jobDetailsAvailable: true,
    jobDetailsComplete: options.complete ?? true,
  });
  return evidence === null ? false : detectRunnerLoss(evidence);
}

describe("PR E2E hosted-runner-loss classifier", () => {
  it("accepts a terminalized hosted shutdown only with canonical lost-communication evidence", () => {
    expect(confirmsRunnerLoss()).toBe(true);
  });

  it("accepts the exact authenticated terminal shutdown block from run 29988226653", () => {
    expect(
      confirmsRunnerLoss({
        jobs: [
          hostedRunnerLossJob({
            annotations: [genericCancellationAnnotation()],
            logEvidence: runnerShutdownLogEvidence(),
          }),
        ],
      }),
    ).toBe(true);
  });

  it("accepts a bounded orphan-process suffix after the terminal shutdown block", () => {
    expect(
      confirmsRunnerLoss({
        jobs: [
          hostedRunnerLossJob({
            annotations: [genericCancellationAnnotation()],
            logEvidence: runnerShutdownLogEvidence(
              runnerShutdownLogTail([orphanProcessLogLine(0, 4_321, "node")]),
            ),
          }),
        ],
      }),
    ).toBe(true);
  });

  it("ignores carriage-return progress output before the exact terminal shutdown block", () => {
    expect(
      confirmsRunnerLoss({
        jobs: [
          hostedRunnerLossJob({
            annotations: [genericCancellationAnnotation()],
            logEvidence: runnerShutdownLogEvidence(
              `2026-07-23T07:31:00.0000000Z build progress 50%\r\n${runnerShutdownLogTail()}`,
            ),
          }),
        ],
      }),
    ).toBe(true);
  });

  it("allows a trusted notice beside the sole shutdown failure annotation", () => {
    expect(
      confirmsRunnerLoss({
        jobs: [
          hostedRunnerLossJob({
            annotations: [
              genericCancellationAnnotation(),
              {
                ...runnerLossAnnotation("Docker credentials were withheld."),
                startLine: 53,
                endLine: 53,
                annotationLevel: "notice",
              },
            ],
            logEvidence: runnerShutdownLogEvidence(),
          }),
        ],
      }),
    ).toBe(true);
  });

  it("accepts at most 64 unique bounded orphan-process records", () => {
    expect(
      confirmsRunnerLoss({
        jobs: [
          hostedRunnerLossJob({
            annotations: [genericCancellationAnnotation()],
            logEvidence: runnerShutdownLogEvidence(
              runnerShutdownLogTail(
                Array.from({ length: 64 }, (_, index) => orphanProcessLogLine(index)),
              ),
            ),
          }),
        ],
      }),
    ).toBe(true);
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

  it("allows an unrelated notice beside the sole canonical failure annotation", () => {
    expect(
      confirmsRunnerLoss({
        jobs: [
          hostedRunnerLossJob({
            annotations: [
              runnerLossAnnotation(),
              {
                ...runnerLossAnnotation("Docker credentials were withheld."),
                startLine: 53,
                endLine: 53,
                annotationLevel: "notice",
              },
            ],
          }),
        ],
      }),
    ).toBe(true);
  });

  it.each([
    {
      label: "the only failure annotation is the generic cancellation from run 29965049603",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [runnerLossAnnotation("The operation was canceled.")],
          }),
        ],
      },
    },
    {
      label: "the shutdown log has no generic failure annotation",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [],
            logEvidence: runnerShutdownLogEvidence(),
          }),
        ],
      },
    },
    {
      label: "the shutdown log is followed by later output",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [genericCancellationAnnotation()],
            logEvidence: runnerShutdownLogEvidence(
              `${runnerShutdownLogTail()}2026-07-23T07:32:51.0000000Z later output\n`,
            ),
          }),
        ],
      },
    },
    {
      label: "the shutdown log omits its final line feed",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [genericCancellationAnnotation()],
            logEvidence: runnerShutdownLogEvidence(runnerShutdownLogTail().slice(0, -1)),
          }),
        ],
      },
    },
    {
      label: "the shutdown log uses CRLF records",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [genericCancellationAnnotation()],
            logEvidence: runnerShutdownLogEvidence(
              runnerShutdownLogTail().replaceAll("\n", "\r\n"),
            ),
          }),
        ],
      },
    },
    {
      label: "the shutdown log ends with an extra blank line",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [genericCancellationAnnotation()],
            logEvidence: runnerShutdownLogEvidence(`${runnerShutdownLogTail()}\n`),
          }),
        ],
      },
    },
    {
      label: "the shutdown log has a second explicit cancellation failure",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [
              genericCancellationAnnotation(),
              runnerLossAnnotation(
                "Canceling since a higher priority waiting request for CI / Pull Request exists",
              ),
            ],
            logEvidence: runnerShutdownLogEvidence(),
          }),
        ],
      },
    },
    {
      label: "the shutdown log records the terminal messages out of order",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [genericCancellationAnnotation()],
            logEvidence: runnerShutdownLogEvidence(
              [
                "2026-07-23T07:32:47.0261924Z ##[error]The operation was canceled.",
                `2026-07-23T07:32:49.9360750Z ##[error]${RUNNER_SHUTDOWN_MESSAGE}`,
                "2026-07-23T07:32:50.0577487Z Cleaning up orphan processes",
                "",
              ].join("\n"),
            ),
          }),
        ],
      },
    },
    {
      label: "the shutdown log timestamps move backward",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [genericCancellationAnnotation()],
            logEvidence: runnerShutdownLogEvidence(
              [
                `2026-07-23T07:32:47.0261924Z ##[error]${RUNNER_SHUTDOWN_MESSAGE}`,
                "2026-07-23T07:32:49.9360750Z ##[error]The operation was canceled.",
                "2026-07-23T07:32:48.0577487Z Cleaning up orphan processes",
                "",
              ].join("\n"),
            ),
          }),
        ],
      },
    },
    {
      label: "the shutdown log repeats an orphan-process PID",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [genericCancellationAnnotation()],
            logEvidence: runnerShutdownLogEvidence(
              runnerShutdownLogTail([
                orphanProcessLogLine(0, 4_321, "node"),
                orphanProcessLogLine(1, 4_321, "node"),
              ]),
            ),
          }),
        ],
      },
    },
    {
      label: "the shutdown log records an invalid orphan process",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [genericCancellationAnnotation()],
            logEvidence: runnerShutdownLogEvidence(
              runnerShutdownLogTail([orphanProcessLogLine(0, 4_321, "node/worker")]),
            ),
          }),
        ],
      },
    },
    {
      label: "the shutdown log contains more than 64 orphan-process records",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [genericCancellationAnnotation()],
            logEvidence: runnerShutdownLogEvidence(
              runnerShutdownLogTail(
                Array.from({ length: 65 }, (_, index) => orphanProcessLogLine(index)),
              ),
            ),
          }),
        ],
      },
    },
    {
      label: "the operation cancellation timestamp does not match the cancelled step",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [genericCancellationAnnotation()],
            logEvidence: runnerShutdownLogEvidence(),
            steps: hostedRunnerLossJob().steps.map((step) =>
              step.conclusion === "cancelled"
                ? { ...step, completedAt: "2026-07-23T07:32:48Z" }
                : step,
            ),
          }),
        ],
      },
    },
    {
      label: "the failure annotation reports a job timeout",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [
              runnerLossAnnotation(
                "The job running on runner GitHub Actions 123 has exceeded the maximum execution time of 75 minutes.",
              ),
            ],
          }),
        ],
      },
    },
    {
      label: "the canonical annotation is bound to a different workflow SHA",
      options: {
        jobs: [
          hostedRunnerLossJob({
            annotations: [
              {
                ...runnerLossAnnotation(),
                blobHref: `https://github.com/NVIDIA/NemoClaw/blob/${"e".repeat(40)}/.github`,
              },
            ],
          }),
        ],
      },
    },
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
