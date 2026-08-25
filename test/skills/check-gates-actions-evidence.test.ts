// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ActionJobFixture } from "./check-gates-test-fixtures.ts";
import {
  BASE_SHA,
  CUSTOM_RUN_URL,
  e2eChecks,
  e2eGateCheck,
  e2eJobs,
  e2eRunFixture,
  exactDiffGateRun,
  HEAD_SHA,
  INCOMPLETE_E2E,
  REQUIRED_CHECK_NAMES,
  runGate,
  successfulRequiredChecks,
  successfulRequiredChecksWithoutE2e,
} from "./check-gates-test-fixtures.ts";

const ADVISOR_WORKFLOW_NAME = "Automation / PR Review Advisor";
const ADVISOR_WORKFLOW_PATH = ".github/workflows/pr-review-advisor.yaml";
const NEMOTRON_ADVISOR_JOB = "PR review advisor (Nemotron 3 Ultra)";

interface AdvisorCheckOptions {
  name?: string;
  workflowName?: string;
  detailsUrl?: string;
  status?: string;
  conclusion?: string;
}

interface AdvisorRunOptions {
  jobName?: string;
  path?: string;
  event?: string;
  headSha?: string;
  headBranch?: string;
  headRepository?: string;
  pullRequests?: unknown[];
  status?: string;
  conclusion?: string | null;
  jobStatus?: string;
  jobConclusion?: string | null;
}

function advisorCheck(runId: number, jobId: number, options: AdvisorCheckOptions = {}) {
  return {
    __typename: "CheckRun",
    name: NEMOTRON_ADVISOR_JOB,
    workflowName: ADVISOR_WORKFLOW_NAME,
    detailsUrl: `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}/job/${jobId}`,
    startedAt: "2026-01-01T00:00:00Z",
    status: "COMPLETED",
    conclusion: "FAILURE",
    ...options,
  };
}

function advisorRun(jobId: number, options: AdvisorRunOptions = {}) {
  return {
    attempt: 1,
    headSha: BASE_SHA,
    headBranch: "main",
    headRepository: "NVIDIA/NemoClaw",
    pullRequestHeadSha: HEAD_SHA,
    baseSha: BASE_SHA,
    event: "pull_request_target",
    path: ADVISOR_WORKFLOW_PATH,
    status: "completed",
    conclusion: "failure",
    jobs: [
      {
        id: jobId,
        name: options.jobName ?? NEMOTRON_ADVISOR_JOB,
        status: options.jobStatus ?? "completed",
        conclusion: options.jobConclusion === undefined ? "failure" : options.jobConclusion,
      },
    ],
    ...options,
  };
}

describe("maintainer merge-gate contributor compliance", () => {
  it("requires PR/base SHA evidence for optional Actions checks", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [
        ...successfulRequiredChecks(),
        {
          __typename: "CheckRun",
          name: "optional-check",
          workflowName: "CI / Optional",
          detailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/443/job/41",
          startedAt: "2026-01-01T00:00:00Z",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        },
      ],
      actionRunAttempts: {
        "443": {
          ...exactDiffGateRun("success", [{ id: 41, name: "optional-check" }]),
          headSha: "stale",
          pullRequestHeadSha: HEAD_SHA,
        },
      },
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["optional-check: latest attempt evidence incomplete"],
    });
    expect(output.allPass).toBe(false);
  });

  it.each([
    {
      state: "failed",
      name: "PR review advisor (GPT-5.6 Terra)",
      runId: 9001,
      status: "COMPLETED",
      conclusion: "FAILURE",
      runStatus: "completed",
      runConclusion: "failure",
    },
    {
      state: "pending",
      name: NEMOTRON_ADVISOR_JOB,
      runId: 9002,
      status: "IN_PROGRESS",
      conclusion: undefined,
      runStatus: "in_progress",
      runConclusion: null,
    },
  ])("keeps an authenticated $state PR Review Advisor lane advisory", ({
    name,
    runId,
    status,
    conclusion,
    runStatus,
    runConclusion,
  }) => {
    const jobId = runId + 100;
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [
        ...successfulRequiredChecks(),
        advisorCheck(runId, jobId, { name, status, conclusion }),
      ],
      actionRunAttempts: {
        [String(runId)]: advisorRun(jobId, {
          jobName: name,
          status: runStatus,
          conclusion: runConclusion,
          jobStatus: runStatus,
          jobConclusion: runConclusion,
        }),
      },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it("keeps a current fork Advisor lane advisory without a REST PR association", () => {
    const runId = 9003;
    const jobId = 9103;
    const forkRepository = "contributor/NemoClaw";
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      headRepository: forkRepository,
      statusChecks: [...successfulRequiredChecks(), advisorCheck(runId, jobId)],
      actionRunAttempts: {
        [String(runId)]: advisorRun(jobId, {
          headSha: HEAD_SHA,
          headBranch: "feature-branch",
          headRepository: forkRepository,
          pullRequests: [],
          status: "completed",
          conclusion: "failure",
        }),
      },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it.each([
    {
      evidence: "the workflow run is in progress",
      run: { status: "in_progress", conclusion: "failure" },
    },
    {
      evidence: "the completed workflow run has no conclusion",
      run: { status: "completed", conclusion: null },
    },
  ])("keeps an association-less fork Advisor lane merge-relevant when $evidence", ({ run }) => {
    const runId = 9005;
    const jobId = 9105;
    const forkRepository = "contributor/NemoClaw";
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      headRepository: forkRepository,
      statusChecks: [...successfulRequiredChecks(), advisorCheck(runId, jobId)],
      actionRunAttempts: {
        [String(runId)]: advisorRun(jobId, {
          headSha: HEAD_SHA,
          headBranch: "feature-branch",
          headRepository: forkRepository,
          pullRequests: [],
          ...run,
        }),
      },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
  });

  it.each([
    { evidence: "the head SHA differs", run: { headSha: BASE_SHA } },
    { evidence: "the head ref differs", run: { headBranch: "other-branch" } },
    {
      evidence: "the head repository differs",
      run: { headRepository: "attacker/NemoClaw" },
    },
  ])("keeps an association-less fork Advisor lane merge-relevant when $evidence", ({ run }) => {
    const runId = 9004;
    const jobId = 9104;
    const forkRepository = "contributor/NemoClaw";
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      headRepository: forkRepository,
      statusChecks: [...successfulRequiredChecks(), advisorCheck(runId, jobId)],
      actionRunAttempts: {
        [String(runId)]: advisorRun(jobId, {
          headSha: HEAD_SHA,
          headBranch: "feature-branch",
          headRepository: forkRepository,
          pullRequests: [],
          ...run,
        }),
      },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
  });

  it.each([
    { evidence: "the REST job has another name", run: { jobName: "unrelated job" } },
    {
      evidence: "the job URL has an attacker origin",
      check: {
        detailsUrl: "https://attacker.example/NVIDIA/NemoClaw/actions/runs/9010/job/9110",
      },
    },
    {
      evidence: "the job URL names another repository",
      check: {
        detailsUrl: "https://github.com/NVIDIA/OtherRepo/actions/runs/9010/job/9110",
      },
    },
    {
      evidence: "the REST job status differs",
      check: { status: "IN_PROGRESS", conclusion: undefined },
      run: {
        status: "in_progress",
        conclusion: null,
        jobStatus: "queued",
        jobConclusion: null,
      },
    },
    { evidence: "the REST job conclusion differs", run: { jobConclusion: "success" } },
    { evidence: "the workflow path differs", run: { path: ".github/workflows/other.yaml" } },
    { evidence: "the workflow path is missing", run: { path: undefined } },
    { evidence: "the workflow event differs", run: { event: "workflow_dispatch" } },
    { evidence: "the PR association is missing", run: { pullRequests: [] } },
    { evidence: "the workflow name is missing", check: { workflowName: undefined } },
    { evidence: "the workflow name differs", check: { workflowName: "Automation / PR Review Advisor 2" } },
    {
      evidence: "the run URL has no job",
      check: { detailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/9010" },
    },
    { evidence: "the run metadata is missing", includeRun: false },
    {
      evidence: "the publish job is not allowlisted",
      check: { name: "Publish PR review advisor" },
      run: { jobName: "Publish PR review advisor" },
    },
    {
      evidence: "a future advisor job is not allowlisted",
      check: { name: "PR review advisor (Future Model)" },
      run: { jobName: "PR review advisor (Future Model)" },
    },
  ])("keeps an advisor-like check merge-relevant when $evidence", ({ check, run, includeRun }) => {
    const runId = 9010;
    const jobId = 9110;
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [...successfulRequiredChecks(), advisorCheck(runId, jobId, check)],
      actionRunAttempts:
        includeRun === false ? undefined : { [String(runId)]: advisorRun(jobId, run) },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
  });

  it("does not accept an advisor workflow job as the required checks context", () => {
    const runId = 9020;
    const jobId = 9120;
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [
        ...successfulRequiredChecks().filter((check) => check.name !== "checks"),
        advisorCheck(runId, jobId, { name: "checks", conclusion: "SUCCESS" }),
      ],
      actionRunAttempts: {
        [String(runId)]: advisorRun(jobId, {
          jobName: "checks",
          status: "completed",
          conclusion: "success",
          jobConclusion: "success",
        }),
      },
    });

    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ allPass: false, gates: { ci: { pass: false } } });
    expect(output.gates.ci.failingChecks).toContain("checks: latest attempt evidence incomplete");
  });

  it.each([
    "push",
    "dynamic",
  ])("accepts an optional %s check tied to the current head SHA", (event) => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [
        ...successfulRequiredChecks(),
        {
          __typename: "CheckRun",
          name: "optional-check",
          workflowName: "CI / Optional",
          detailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/446/job/41",
          startedAt: "2026-01-01T00:00:00Z",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        },
      ],
      actionRunAttempts: {
        "446": {
          attempt: 1,
          headSha: HEAD_SHA,
          event,
          path: ".github/workflows/optional.yaml",
          status: "completed",
          conclusion: "success",
          jobs: [{ id: 41, name: "optional-check" }],
        },
      },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it("accepts duplicate optional runs with exact-PR and current-head identities", () => {
    const optionalCheck = (runId: number, jobId: number, startedAt: string) => ({
      __typename: "CheckRun",
      name: "request",
      workflowName: "Automation / Request NVSkills CI",
      detailsUrl: `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}/job/${jobId}`,
      startedAt,
      status: "COMPLETED",
      conclusion: "SKIPPED",
    });
    const skippedJob = (id: number): ActionJobFixture => ({
      id,
      name: "request",
      conclusion: "skipped",
    });
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [
        ...successfulRequiredChecks(),
        optionalCheck(447, 41, "2026-01-01T00:00:00Z"),
        optionalCheck(448, 42, "2026-01-01T00:02:00Z"),
      ],
      actionRunAttempts: {
        "447": {
          ...exactDiffGateRun("skipped", [skippedJob(41)]),
          event: "push",
          path: ".github/workflows/request-nvskills-ci.yml",
        },
        "448": {
          attempt: 1,
          headSha: HEAD_SHA,
          event: "push",
          path: ".github/workflows/request-nvskills-ci.yml",
          status: "completed",
          conclusion: "skipped",
          jobs: [skippedJob(42)],
        },
      },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it("uses the latest attempt for duplicate check-run contexts", () => {
    const result = runGate(
      e2eRunFixture(
        [
          [100, 1, "CANCELLED"],
          [101, 2, "SUCCESS"],
        ],
        {
          "100": {
            ...exactDiffGateRun("cancelled", [{ id: 1, name: "E2E / PR Gate" }]),
            createdAt: "2026-01-01T00:00:00Z",
          },
          "101": {
            ...exactDiffGateRun("success", [{ id: 2, name: "E2E / PR Gate" }]),
            createdAt: "2026-01-01T00:01:00Z",
          },
        },
      ),
    );

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci).toMatchObject({ pass: true });
  });
  it("keeps every duplicate job from the latest workflow run", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [
        ...REQUIRED_CHECK_NAMES.map((name) => ({
          __typename: "CheckRun",
          name,
          workflowName: `CI / ${name}`,
          detailsUrl: `https://github.com/NVIDIA/NemoClaw/actions/runs/200/job/${name}`,
          startedAt: "2026-01-01T00:02:00Z",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        })),
        {
          __typename: "CheckRun",
          name: "matrix-check",
          workflowName: "CI / Matrix",
          detailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/199/job/1",
          startedAt: "2026-01-01T00:00:00Z",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        },
        {
          __typename: "CheckRun",
          name: "matrix-check",
          workflowName: "CI / Matrix",
          detailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/200/job/2",
          startedAt: "2026-01-01T00:02:00Z",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        },
        {
          __typename: "CheckRun",
          name: "matrix-check",
          workflowName: "CI / Matrix",
          detailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/200/job/3",
          startedAt: "2026-01-01T00:03:00Z",
          status: "COMPLETED",
          conclusion: "FAILURE",
        },
      ],
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["matrix-check: FAILURE"],
    });
  });
  it("accepts SHA evidence from a non-PR Actions event", () => {
    const fixture = e2eRunFixture(e2eChecks([874, 2, "SUCCESS"]), {
      "874": exactDiffGateRun("success", e2eJobs(2)),
      "875": {
        attempt: 1,
        headSha: HEAD_SHA,
        event: "dynamic",
        path: "dynamic/github-code-scanning/codeql",
        status: "completed",
        conclusion: "success",
        jobs: [{ id: 1, name: "optional-check" }],
      },
    });
    fixture.statusChecks?.push(
      e2eGateCheck([875, 1, "SUCCESS", undefined, undefined, "CodeQL", "optional-check"]),
    );
    expect(JSON.parse(runGate(fixture).stdout).gates.ci).toMatchObject({ pass: true });
  });
  it("uses the latest attempt for custom check-run details URLs", () => {
    const fixture = e2eRunFixture(
      [
        [874, 2, "SUCCESS"],
        [0, 0, "FAILURE", "2026-01-01T00:00:00Z", `${CUSTOM_RUN_URL}1`, "CodeQL", "custom-check"],
        [0, 0, "SUCCESS", "2026-01-01T00:02:00Z", `${CUSTOM_RUN_URL}2`, "CodeQL", "custom-check"],
      ],
      { "874": exactDiffGateRun("success", e2eJobs(2)) },
    );
    expect(JSON.parse(runGate(fixture).stdout).gates.ci).toMatchObject({ pass: true });
  });
  it("uses an envelope-bound E2E run when a later association-less label run is skipped", () => {
    const fixture = e2eRunFixture(
      [
        [400, 40, "SUCCESS"],
        [401, 41, "SKIPPED"],
      ],
      {
        "400": {
          ...exactDiffGateRun("success", [
            { id: 40, name: "E2E / PR Gate" },
            {
              id: 42,
              name: "initialize",
              startedAt: "2026-01-01T00:01:00Z",
              completedAt: "2026-01-01T00:03:00Z",
            },
          ]),
          pullRequests: [],
          createdAt: "2026-01-01T00:01:00Z",
          updatedAt: "2026-01-01T00:03:00Z",
        },
        "401": {
          ...exactDiffGateRun("skipped", [
            { id: 41, name: "E2E / PR Gate", conclusion: "skipped" },
          ]),
          pullRequests: [],
          createdAt: "2026-01-01T00:04:00Z",
          updatedAt: "2026-01-01T00:05:00Z",
          displayTitle: `E2E Gate PR #42 head ${HEAD_SHA} base ${BASE_SHA} gate false`,
        },
      },
    );
    const result = runGate({
      ...fixture,
      statusChecks: fixture.statusChecks?.filter((check) => check.name !== "initialize"),
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });
});
