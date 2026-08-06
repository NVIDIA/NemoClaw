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
