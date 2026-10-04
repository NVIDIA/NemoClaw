// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  type HostedRunnerLossPolicy,
  verifiedRunnerLossEvidence,
  type WorkflowJob,
  type WorkflowJobAnnotation,
} from "../../../tools/e2e/hosted-runner-loss.mts";
import { detectRunnerLoss } from "../../../tools/e2e/runner-pressure-core.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const WORKFLOW_SHA = "d".repeat(40);
const RUN_ID = 29_897_237_525;
const JOB_ID = 89_074_697_099;
const API_REPOSITORY = `https://api.github.com/repos/${REPOSITORY}`;
const WEB_REPOSITORY = `https://github.com/${REPOSITORY}`;
const RUN_URL = `${API_REPOSITORY}/actions/runs/${RUN_ID}`;
const JOB_API_URL = `${API_REPOSITORY}/actions/jobs/${JOB_ID}`;
const CHECK_URL = `${API_REPOSITORY}/check-runs/${JOB_ID}`;
const JOB_HTML_URL = `${WEB_REPOSITORY}/actions/runs/${RUN_ID}/job/${JOB_ID}`;
const INTERNAL_ERROR_MESSAGE =
  "GitHub Actions has encountered an internal error when running your job.";

const WINDOWS_POLICY: HostedRunnerLossPolicy = {
  githubInternalError: {
    approvedRunnerLabels: ["windows-latest"],
    approvedJobConclusions: ["cancelled"],
  },
};

function internalErrorAnnotation(
  overrides: Partial<WorkflowJobAnnotation> = {},
): WorkflowJobAnnotation {
  return {
    path: ".github",
    blobHref: `${WEB_REPOSITORY}/blob/${WORKFLOW_SHA}/.github`,
    startLine: 1,
    startColumn: null,
    endLine: 1,
    endColumn: null,
    annotationLevel: "failure",
    title: "",
    message: INTERNAL_ERROR_MESSAGE,
    rawDetails: "",
    ...overrides,
  };
}

function internalErrorJob(overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  const job: WorkflowJob = {
    id: JOB_ID,
    name: "MCP bridge (windows-latest)",
    runId: RUN_ID,
    runAttempt: 1,
    headSha: WORKFLOW_SHA,
    runUrl: RUN_URL,
    apiUrl: JOB_API_URL,
    htmlUrl: JOB_HTML_URL,
    checkRunUrl: CHECK_URL,
    status: "completed",
    conclusion: "cancelled",
    runnerId: 1_021_277_393,
    runnerName: "GitHub Actions 1021277393",
    runnerGroupId: 0,
    runnerGroupName: "GitHub Actions",
    labels: ["windows-latest"],
    annotations: [internalErrorAnnotation()],
    steps: [
      { name: "Set up job", status: "completed", conclusion: "success" },
      { name: "Run MCP bridge test", status: "in_progress", conclusion: null },
      { name: "Upload artifacts", status: "pending", conclusion: null },
    ],
  };
  job.checkEvidence = {
    id: job.id,
    name: job.name,
    headSha: WORKFLOW_SHA,
    apiUrl: CHECK_URL,
    htmlUrl: JOB_HTML_URL,
    detailsUrl: JOB_HTML_URL,
    status: "completed",
    conclusion: job.conclusion,
    appId: 15368,
    appSlug: "github-actions",
    annotationsCount: 1,
    annotationsUrl: `${CHECK_URL}/annotations`,
  };
  return { ...job, ...overrides };
}

function withCheck(
  job: WorkflowJob,
  overrides: Partial<NonNullable<WorkflowJob["checkEvidence"]>>,
): WorkflowJob {
  return {
    ...job,
    checkEvidence: { ...job.checkEvidence!, ...overrides },
  };
}

function confirmsInternalError(
  job: WorkflowJob,
  policy: HostedRunnerLossPolicy = WINDOWS_POLICY,
  workflowConclusion = "failure",
): boolean {
  const evidence = verifiedRunnerLossEvidence({
    repository: REPOSITORY,
    workflowSha: WORKFLOW_SHA,
    workflowConclusion,
    jobs: [job],
    jobDetailsAvailable: true,
    jobDetailsComplete: true,
    policy,
  });
  return evidence !== null && detectRunnerLoss(evidence);
}

describe("hosted-runner GitHub internal-error evidence", () => {
  it("accepts an exact assigned Windows runner only after explicit opt-in (#7140)", () => {
    expect(confirmsInternalError(internalErrorJob())).toBe(true);
    expect(confirmsInternalError(internalErrorJob(), {})).toBe(false);
  });

  it("accepts an exact assigned macOS runner under its own label policy (#7140)", () => {
    const job = internalErrorJob({
      name: "MCP bridge (macos-26)",
      labels: ["macos-26"],
      runnerId: 1_021_277_394,
      runnerName: "GitHub Actions 1021277394",
    });
    const exactJob = withCheck(job, { name: job.name });
    expect(
      confirmsInternalError(exactJob, {
        githubInternalError: {
          approvedRunnerLabels: ["macos-26"],
          approvedJobConclusions: ["cancelled"],
        },
      }),
    ).toBe(true);
  });

  it("requires a failed workflow even for an authenticated cancelled job (#7140)", () => {
    expect(confirmsInternalError(internalErrorJob(), WINDOWS_POLICY, "cancelled")).toBe(false);
  });

  it("supports an explicitly approved failed internal-error job (#7140)", () => {
    const job = internalErrorJob({ conclusion: "failure" });
    const exactJob = withCheck(job, { conclusion: "failure" });
    expect(
      confirmsInternalError(exactJob, {
        githubInternalError: {
          approvedRunnerLabels: ["windows-latest"],
          approvedJobConclusions: ["failure"],
        },
      }),
    ).toBe(true);
  });

  it("rejects a job conclusion that its caller did not approve (#7140)", () => {
    expect(
      confirmsInternalError(internalErrorJob(), {
        githubInternalError: {
          approvedRunnerLabels: ["windows-latest"],
          approvedJobConclusions: ["failure"],
        },
      }),
    ).toBe(false);
  });

  it.each([
    ["runner ID", { runnerId: null }],
    ["runner name", { runnerName: "self-hosted-windows" }],
    ["runner group ID", { runnerGroupId: 1 }],
    ["runner group name", { runnerGroupName: "Custom runners" }],
    ["self-hosted label", { labels: ["windows-latest", "self-hosted"] }],
    ["extra unapproved label", { labels: ["windows-latest", "X64"] }],
    ["unapproved label", { labels: ["windows-2025"] }],
    ["zero steps", { steps: [] }],
  ])("rejects an invalid assigned-runner %s (#7140)", (_label, overrides) => {
    expect(confirmsInternalError(internalErrorJob(overrides))).toBe(false);
  });

  it("requires exactly one approved label match (#7140)", () => {
    const policy: HostedRunnerLossPolicy = {
      githubInternalError: {
        approvedRunnerLabels: ["windows-latest", "macos-26"],
        approvedJobConclusions: ["cancelled"],
      },
    };
    expect(
      confirmsInternalError(internalErrorJob({ labels: ["windows-latest", "macos-26"] }), policy),
    ).toBe(false);
  });

  it.each([
    ["missing prior step", [{ name: "Run", status: "in_progress", conclusion: null }]],
    [
      "missing later step",
      [
        { name: "Set up job", status: "completed", conclusion: "success" },
        { name: "Run", status: "in_progress", conclusion: null },
      ],
    ],
    [
      "failed prior step",
      [
        { name: "Set up job", status: "completed", conclusion: "failure" },
        { name: "Run", status: "in_progress", conclusion: null },
        { name: "Upload", status: "pending", conclusion: null },
      ],
    ],
    [
      "completed later step",
      [
        { name: "Set up job", status: "completed", conclusion: "success" },
        { name: "Run", status: "in_progress", conclusion: null },
        { name: "Upload", status: "completed", conclusion: "skipped" },
      ],
    ],
    [
      "multiple stranded steps",
      [
        { name: "Set up job", status: "completed", conclusion: "success" },
        { name: "Run", status: "in_progress", conclusion: null },
        { name: "Upload", status: "in_progress", conclusion: null },
        { name: "Cleanup", status: "pending", conclusion: null },
      ],
    ],
  ])("rejects a non-exact stranded-step shape: %s (#7140)", (_label, steps) => {
    expect(confirmsInternalError(internalErrorJob({ steps }))).toBe(false);
  });

  it.each([
    ["path", { path: "src/index.ts" }],
    ["blob SHA", { blobHref: `${WEB_REPOSITORY}/blob/${"e".repeat(40)}/.github` }],
    ["start line", { startLine: 2 }],
    ["start column", { startColumn: 1 }],
    ["end line", { endLine: 2 }],
    ["end column", { endColumn: 1 }],
    ["level", { annotationLevel: "warning" }],
    ["title", { title: "Internal error" }],
    ["message", { message: "The operation was canceled." }],
    ["raw details", { rawDetails: "untrusted" }],
  ])("rejects an internal-error annotation with the wrong %s (#7140)", (_label, annotation) => {
    expect(
      confirmsInternalError(
        internalErrorJob({ annotations: [internalErrorAnnotation(annotation)] }),
      ),
    ).toBe(false);
  });

  it("accepts one exact failure annotation alongside an authenticated notice (#7140)", () => {
    const notice = internalErrorAnnotation({
      path: ".github/workflows/e2e.yaml",
      blobHref: `${WEB_REPOSITORY}/blob/${WORKFLOW_SHA}/.github/workflows/e2e.yaml`,
      startLine: 42,
      endLine: 42,
      annotationLevel: "notice",
      message: "Docker Hub credentials are withheld for this ref.",
    });
    const job = internalErrorJob({
      annotations: [internalErrorAnnotation(), notice],
    });
    expect(confirmsInternalError(withCheck(job, { annotationsCount: 2 }))).toBe(true);
  });

  it("rejects multiple failure annotations and authenticated count drift (#7140)", () => {
    const annotations = [internalErrorAnnotation(), internalErrorAnnotation()];
    const multipleFailures = internalErrorJob({ annotations });
    expect(confirmsInternalError(withCheck(multipleFailures, { annotationsCount: 2 }))).toBe(false);
    expect(confirmsInternalError(withCheck(internalErrorJob(), { annotationsCount: 2 }))).toBe(
      false,
    );
  });

  it("rejects internal-error evidence without its authenticated check run (#7140)", () => {
    expect(confirmsInternalError(internalErrorJob({ checkEvidence: undefined }))).toBe(false);
  });

  it.each([
    ["check ID", { id: JOB_ID + 1 }],
    ["check name", { name: "different job" }],
    ["check SHA", { headSha: "e".repeat(40) }],
    ["check API URL", { apiUrl: `${CHECK_URL}-other` }],
    ["check HTML URL", { htmlUrl: `${JOB_HTML_URL}-other` }],
    ["check details URL", { detailsUrl: `${JOB_HTML_URL}-other` }],
    ["check status", { status: "in_progress" }],
    ["check conclusion", { conclusion: "failure" }],
    ["app ID", { appId: 7 }],
    ["app slug", { appSlug: "github-actions-enterprise" }],
    ["annotation URL", { annotationsUrl: `${CHECK_URL}/other` }],
  ])("rejects internal-error check evidence with the wrong %s (#7140)", (_label, check) => {
    expect(confirmsInternalError(withCheck(internalErrorJob(), check))).toBe(false);
  });

  it.each([
    ["job SHA", { headSha: "e".repeat(40) }],
    ["run URL", { runUrl: `${RUN_URL}-other` }],
    ["job API URL", { apiUrl: `${JOB_API_URL}-other` }],
    ["job HTML URL", { htmlUrl: `${JOB_HTML_URL}-other` }],
    ["check-run URL", { checkRunUrl: `${CHECK_URL}-other` }],
    ["run ID", { runId: RUN_ID + 1 }],
    ["run attempt", { runAttempt: 0 }],
  ])("rejects internal-error job evidence with the wrong %s (#7140)", (_label, job) => {
    expect(confirmsInternalError(internalErrorJob(job))).toBe(false);
  });

  it("rejects a mixed run with any ordinary failure (#7140)", () => {
    const evidence = verifiedRunnerLossEvidence({
      repository: REPOSITORY,
      workflowSha: WORKFLOW_SHA,
      workflowConclusion: "failure",
      jobs: [
        internalErrorJob(),
        {
          ...internalErrorJob(),
          id: JOB_ID + 1,
          name: "ordinary assertion",
          conclusion: "failure",
          runnerId: null,
          runnerName: null,
          annotations: [],
          checkEvidence: undefined,
          steps: [{ name: "Run tests", status: "completed", conclusion: "failure" }],
        },
      ],
      jobDetailsAvailable: true,
      jobDetailsComplete: true,
      policy: WINDOWS_POLICY,
    });
    expect(evidence).not.toBeNull();
    expect(detectRunnerLoss(evidence!)).toBe(false);
  });

  it("rejects zero-job and incomplete evidence (#7140)", () => {
    const base = {
      repository: REPOSITORY,
      workflowSha: WORKFLOW_SHA,
      workflowConclusion: "failure",
      jobs: [] as WorkflowJob[],
      jobDetailsAvailable: true,
      jobDetailsComplete: true,
      policy: WINDOWS_POLICY,
    };
    expect(verifiedRunnerLossEvidence(base)).toBeNull();
    expect(
      verifiedRunnerLossEvidence({
        ...base,
        jobs: [internalErrorJob()],
        jobDetailsComplete: false,
      }),
    ).toBeNull();
  });

  it("rejects an empty internal-error policy (#7140)", () => {
    expect(() =>
      confirmsInternalError(internalErrorJob(), {
        githubInternalError: {} as never,
      }),
    ).toThrow(/policy/u);
  });

  it.each([
    { githubInternalError: { approvedRunnerLabels: [], approvedJobConclusions: ["cancelled"] } },
    {
      githubInternalError: {
        approvedRunnerLabels: ["windows-*"],
        approvedJobConclusions: ["cancelled"],
      },
    },
    {
      githubInternalError: {
        approvedRunnerLabels: ["self-hosted"],
        approvedJobConclusions: ["cancelled"],
      },
    },
    {
      githubInternalError: {
        approvedRunnerLabels: ["windows-latest", "windows-latest"],
        approvedJobConclusions: ["cancelled"],
      },
    },
    {
      githubInternalError: {
        approvedRunnerLabels: ["windows-latest"],
        approvedJobConclusions: [],
      },
    },
    {
      githubInternalError: {
        approvedRunnerLabels: ["windows-latest"],
        approvedJobConclusions: ["cancelled", "cancelled"],
      },
    },
    {
      githubInternalError: {
        approvedRunnerLabels: ["windows-latest"],
        approvedJobConclusions: ["success"],
      },
    },
    { unsupported: true },
  ])("rejects malformed internal-error policy %# (#7140)", (policy) => {
    expect(() =>
      confirmsInternalError(internalErrorJob(), policy as HostedRunnerLossPolicy),
    ).toThrow(/policy/u);
  });
});
