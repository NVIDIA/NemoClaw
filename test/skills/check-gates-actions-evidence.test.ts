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

  it.each([
    {
      name: "workflow-run status",
      run: { status: "future_status" },
    },
    {
      name: "workflow-run conclusion",
      run: { conclusion: "future_conclusion" },
    },
    {
      name: "job status",
      job: { status: "future_status" },
    },
    {
      name: "job conclusion",
      job: { conclusion: "future_conclusion" },
    },
  ])("fails closed on an unknown $name", ({ run, job }) => {
    const result = runGate(
      e2eRunFixture(e2eChecks([444, 41, "SUCCESS"]), {
        "444": {
          ...exactDiffGateRun("success", [{ id: 41, name: "E2E / PR Gate", ...job }]),
          ...run,
        },
      }),
    );

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["E2E / PR Gate: latest attempt evidence incomplete"],
    });
    expect(output.allPass).toBe(false);
  });

  it.each([
    {
      name: "still running",
      run: { status: "in_progress", conclusion: null },
      jobs: [{ id: 41, name: "E2E / PR Gate" }],
    },
    {
      name: "failed with a differently named failed job",
      run: { status: "completed", conclusion: "failure" },
      jobs: [
        { id: 41, name: "E2E / PR Gate" },
        { id: 42, name: "hidden-failure", conclusion: "failure" },
      ],
    },
  ])("fails closed when an Actions run is $name", ({ run, jobs }) => {
    const result = runGate(
      e2eRunFixture(e2eChecks([445, 41, "SUCCESS"]), {
        "445": {
          ...exactDiffGateRun("success", jobs),
          ...run,
        },
      }),
    );

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["E2E / PR Gate: latest attempt evidence incomplete"],
    });
    expect(output.allPass).toBe(false);
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
  it("orders overlapping workflow runs by run creation time", () => {
    const result = runGate(
      e2eRunFixture(
        [
          [102, 3, "SUCCESS", "2026-01-01T00:03:00Z"],
          [103, 4, "FAILURE", "2026-01-01T00:02:00Z"],
        ],
        {
          "102": {
            ...exactDiffGateRun("success", [{ id: 3, name: "E2E / PR Gate" }]),
            createdAt: "2026-01-01T00:00:00Z",
          },
          "103": {
            ...exactDiffGateRun("failure", [{ id: 4, name: "E2E / PR Gate" }]),
            createdAt: "2026-01-01T00:01:00Z",
          },
        },
      ),
    );

    expect(JSON.parse(result.stdout).gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["E2E / PR Gate: FAILURE"],
    });
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
  it("rejects required checks represented only by a status context", () => {
    const fixture = e2eRunFixture([], {});
    fixture.statusChecks?.push({
      __typename: "StatusContext",
      context: "E2E / PR Gate",
      state: "SUCCESS",
    });
    expect(JSON.parse(runGate(fixture).stdout).gates.ci).toMatchObject({
      pass: false,
      failingChecks: INCOMPLETE_E2E,
    });
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
  it("uses the latest attempt when GitHub reuses an Actions run ID", () => {
    const fixture = {
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [
        ...successfulRequiredChecksWithoutE2e(),
        e2eGateCheck([300, 10, "FAILURE", "2026-01-01T00:00:00Z"]),
        e2eGateCheck([300, 20, "SUCCESS", "2026-01-01T00:02:00Z"]),
      ],
    };
    const result = runGate({
      ...fixture,
      actionRunAttempts: {
        "300": exactDiffGateRun("success", [{ id: 20, name: "E2E / PR Gate" }], 2),
      },
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci).toMatchObject({ pass: true });

    const unavailable = runGate(fixture);
    expect(JSON.parse(unavailable.stdout).gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["E2E / PR Gate: FAILURE"],
    });
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

  it("does not discard a skipped E2E run with malformed immutable identity", () => {
    const result = runGate(
      e2eRunFixture(
        [
          [405, 45, "SUCCESS"],
          [406, 46, "SKIPPED"],
        ],
        {
          "405": exactDiffGateRun("success", [{ id: 45, name: "E2E / PR Gate" }]),
          "406": {
            ...exactDiffGateRun("skipped", [
              { id: 46, name: "E2E / PR Gate", conclusion: "skipped" },
            ]),
            displayTitle: "E2E Gate stale metadata",
          },
        },
      ),
    );

    expect(JSON.parse(result.stdout).gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["E2E / PR Gate: SKIPPED"],
    });
  });

  it.each([
    [
      "does not enclose trusted coordination",
      {
        createdAt: "2026-01-01T00:02:00Z",
        updatedAt: "2026-01-01T00:03:00Z",
      },
    ],
    [
      "names another PR base",
      {
        displayTitle: `E2E Gate PR #42 head ${HEAD_SHA} base ${"c".repeat(40)} gate true`,
      },
    ],
    [
      "names another PR number",
      {
        displayTitle: `E2E Gate PR #43 head ${HEAD_SHA} base ${BASE_SHA} gate true`,
      },
    ],
    ["has another head branch", { headBranch: "other-branch" }],
    ["has another head repository", { headRepository: "example/fork" }],
  ])("rejects an association-less E2E run that %s", (_name, overrides) => {
    const result = runGate(
      e2eRunFixture(e2eChecks([402, 42, "SUCCESS"]), {
        "402": {
          ...exactDiffGateRun("success", [{ id: 42, name: "E2E / PR Gate" }]),
          pullRequests: [],
          ...overrides,
        },
      }),
    );

    expect(JSON.parse(result.stdout).gates.ci).toMatchObject({
      pass: false,
      failingChecks: INCOMPLETE_E2E,
    });
  });

  it("fails closed when an Actions run timing changes during job collection", () => {
    const result = runGate(
      e2eRunFixture(e2eChecks([403, 43, "SUCCESS"]), {
        "403": {
          ...exactDiffGateRun("success", [{ id: 43, name: "E2E / PR Gate" }]),
          nextUpdatedAt: "2026-01-01T00:04:00Z",
        },
      }),
    );

    expect(JSON.parse(result.stdout).gates.ci).toMatchObject({
      pass: false,
      failingChecks: INCOMPLETE_E2E,
    });
  });

  it("fails closed when E2E controller identity changes during job collection", () => {
    const result = runGate(
      e2eRunFixture(e2eChecks([404, 44, "SUCCESS"]), {
        "404": {
          ...exactDiffGateRun("success", [{ id: 44, name: "E2E / PR Gate" }]),
          nextDisplayTitle: `E2E Gate PR #42 head ${HEAD_SHA} base ${"c".repeat(40)} gate true`,
        },
      }),
    );

    expect(JSON.parse(result.stdout).gates.ci).toMatchObject({
      pass: false,
      failingChecks: INCOMPLETE_E2E,
    });
  });
});
