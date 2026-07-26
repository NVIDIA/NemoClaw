// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ActionJobFixture, ActionRunFixture } from "./check-gates-test-fixtures.ts";
import {
  BASE_SHA,
  CUSTOM_RUN_URL,
  coordinationCheck,
  E2E_COORDINATION_EXTERNAL_ID,
  e2eChecks,
  e2eGateCheck,
  e2eJobs,
  e2eRunFixture,
  exactDiffGateRun,
  HEAD_SHA,
  INCOMPLETE_E2E,
  installerHashRun,
  prWorkflowJobs,
  prWorkflowRun,
  REQUIRED_CHECK_NAMES,
  runGate,
  successfulRequiredChecks,
  successfulRequiredChecksWithoutE2e,
} from "./check-gates-test-fixtures.ts";

describe("maintainer merge-gate contributor compliance", () => {
  it("treats a mergeable PR blocked on required review as conflict-free", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.conflicts).toMatchObject({
      pass: true,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
    });
    expect(output.allPass).toBe(true);
  });

  it("fails closed when BLOCKED masks a stale base revision", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        currentBaseSha: "cccccccccccccccccccccccccccccccccccccccc",
      }).stdout,
    );

    expect(output.gates.conflicts).toMatchObject({
      pass: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      baseSha: BASE_SHA,
      currentBaseSha: "cccccccccccccccccccccccccccccccccccccccc",
    });
    expect(output.allPass).toBe(false);
  });

  it("fails closed when the current base revision cannot be verified", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        currentBaseSha: null,
      }).stdout,
    );

    expect(output.gates.conflicts).toMatchObject({
      pass: false,
      baseSha: BASE_SHA,
    });
    expect(output.gates.conflicts.currentBaseSha).toBeUndefined();
    expect(output.allPass).toBe(false);
  });

  it("fails closed while GitHub has not determined mergeability", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.conflicts).toMatchObject({
      pass: false,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    });
    expect(output.allPass).toBe(false);
  });

  it("fails closed when the PR branch is behind its base branch", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BEHIND",
      }).stdout,
    );

    expect(output.gates.conflicts).toMatchObject({
      pass: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
    });
    expect(output.allPass).toBe(false);
  });

  it.each([
    ["title", { title: "fix(policy): changed during review" }],
    ["body", { body: "DCO declaration removed during review" }],
    ["head", { headRefOid: "c".repeat(40) }],
    ["base", { baseRefOid: "c".repeat(40) }],
    ["base branch", { baseRefName: "release" }],
    ["mergeability", { mergeable: "UNKNOWN" }],
    ["merge state", { mergeStateStatus: "UNKNOWN" }],
  ])("fails closed when the PR %s changes during gate evaluation", (_name, finalPr) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        finalPr,
      }).stdout,
    );

    expect(output.gates.conflicts).toMatchObject({
      pass: false,
      details: "PR revision or merge state changed during gate evaluation; rerun the gate checker",
    });
    expect(output.allPass).toBe(false);
  });

  it("makes the PR revision snapshot the final remote read", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        finalPrAfterCurrentBase: { headRefOid: "c".repeat(40) },
      }).stdout,
    );

    expect(output.gates.conflicts).toMatchObject({
      pass: false,
      details: "PR revision or merge state changed during gate evaluation; rerun the gate checker",
    });
    expect(output.allPass).toBe(false);
  });

  it.each([
    ["closes", { state: "CLOSED" }, "PR is no longer open"],
    ["becomes a draft", { isDraft: true }, "PR became a draft during gate evaluation"],
  ])("fails closed when the PR %s", (_name, finalPr, details) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        finalPr,
      }).stdout,
    );

    expect(output.gates.conflicts).toMatchObject({ pass: false, details });
    expect(output.allPass).toBe(false);
  });

  it("requires checks and changes to come from the same substantive PR CI run", () => {
    const statusChecks = successfulRequiredChecks().map((check) =>
      check.name === "changes"
        ? e2eGateCheck([95, 1, "SUCCESS", undefined, undefined, "CI / Pull Request", "changes"])
        : check,
    );
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        statusChecks,
        actionRunAttempts: {
          "95": prWorkflowRun("success", [{ id: 1, name: "changes" }], true),
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({ pass: false });
    expect(output.gates.ci.failingChecks).toEqual(
      expect.arrayContaining([
        "checks: latest attempt evidence incomplete",
        "changes: latest attempt evidence incomplete",
      ]),
    );
  });

  it.each([
    [
      "a stale base in the immutable PR CI title",
      `CI PR #42 head ${HEAD_SHA} base ${"c".repeat(40)} gate true`,
    ],
    [
      "a stale head in the immutable PR CI title",
      `CI PR #42 head ${"c".repeat(40)} base ${BASE_SHA} gate true`,
    ],
    [
      "an unsafe PR number in the immutable PR CI title",
      `CI PR #9007199254740993 head ${HEAD_SHA} base ${BASE_SHA} gate true`,
    ],
    [
      "an uppercase SHA in the immutable PR CI title",
      `CI PR #42 head ${HEAD_SHA.toUpperCase()} base ${BASE_SHA} gate true`,
    ],
  ])("rejects %s even when mutable pull_requests claims the current diff", (_name, displayTitle) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        actionRunAttempts: {
          "90": {
            ...prWorkflowRun(
              "success",
              [
                { id: 1, name: "checks" },
                { id: 2, name: "changes" },
              ],
              true,
            ),
            displayTitle,
          },
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({ pass: false });
    expect(output.gates.ci.failingChecks).toEqual(
      expect.arrayContaining([
        "checks: latest attempt evidence incomplete",
        "changes: latest attempt evidence incomplete",
      ]),
    );
  });

  it("fails closed when immutable PR CI identity changes during job collection", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        actionRunAttempts: {
          "90": {
            ...prWorkflowRun(
              "success",
              [
                { id: 1, name: "checks" },
                { id: 2, name: "changes" },
              ],
              true,
            ),
            nextDisplayTitle: `CI PR #42 head ${HEAD_SHA} base ${"c".repeat(40)} gate true`,
          },
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({ pass: false });
    expect(output.gates.ci.failingChecks).toEqual(
      expect.arrayContaining([
        "checks: latest attempt evidence incomplete",
        "changes: latest attempt evidence incomplete",
      ]),
    );
  });

  it("rejects a required check emitted by the wrong workflow", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        actionRunAttempts: {
          "91": {
            ...exactDiffGateRun("success", [{ id: 1, name: "check-hash" }]),
            event: "pull_request",
            path: ".github/workflows/unrelated.yaml",
          },
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["check-hash: latest attempt evidence incomplete"],
    });
  });

  it("accepts immutable installer identity without relying on retarget timestamps", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        actionRunAttempts: {
          "91": {
            ...installerHashRun("success", [{ id: 1, name: "check-hash" }], true),
            createdAt: "2026-01-01T00:02:00Z",
            updatedAt: "2026-01-01T00:02:00Z",
            pullRequests: [],
          },
        },
      }).stdout,
    );

    expect(output).toMatchObject({ allPass: true, gates: { ci: { pass: true } } });
  });

  it.each(["SKIPPED", "NEUTRAL"])("rejects a required Actions run concluded %s", (conclusion) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        actionRunAttempts: {
          "91": installerHashRun(conclusion.toLowerCase(), [{ id: 1, name: "check-hash" }], true),
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["check-hash: latest attempt evidence incomplete"],
    });
    expect(output.allPass).toBe(false);
  });

  it.each(["SKIPPED", "NEUTRAL"])("rejects a required CheckRun concluded %s", (conclusion) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        statusChecks: successfulRequiredChecks().map((check) =>
          check.name === "check-hash" ? { ...check, conclusion } : check,
        ),
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: [`check-hash: ${conclusion}`],
    });
    expect(output.allPass).toBe(false);
  });

  it.each([
    ["a stale base", `Installer Hash PR #42 head ${HEAD_SHA} base ${"c".repeat(40)} gate true`],
    ["a stale head", `Installer Hash PR #42 head ${"c".repeat(40)} base ${BASE_SHA} gate true`],
    [
      "an unsafe PR number",
      `Installer Hash PR #9007199254740993 head ${HEAD_SHA} base ${BASE_SHA} gate true`,
    ],
    [
      "an uppercase SHA",
      `Installer Hash PR #42 head ${HEAD_SHA.toUpperCase()} base ${BASE_SHA} gate true`,
    ],
    ["a malformed title", "Installer Hash current diff"],
  ])("rejects check-hash with %s in its immutable title", (_name, displayTitle) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        actionRunAttempts: {
          "91": {
            ...installerHashRun("success", [{ id: 1, name: "check-hash" }], true),
            displayTitle,
          },
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["check-hash: latest attempt evidence incomplete"],
    });
  });

  it("does not accept a gate-false installer metadata edit as evidence", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        actionRunAttempts: {
          "91": installerHashRun("success", [{ id: 1, name: "check-hash" }], false),
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["check-hash: latest attempt evidence incomplete"],
    });
  });

  it("rejects installer evidence with a contradictory mutable PR association", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        actionRunAttempts: {
          "91": {
            ...installerHashRun("success", [{ id: 1, name: "check-hash" }], true),
            pullRequests: [
              {
                number: 99,
                head: { sha: HEAD_SHA },
                base: { sha: BASE_SHA },
              },
            ],
          },
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["check-hash: latest attempt evidence incomplete"],
    });
  });

  it("accepts the legacy E2E coordination check name", () => {
    const legacyCheck = coordinationCheck({ id: 8001, name: "E2E / PR Gate" });
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        statusChecks: [
          ...successfulRequiredChecksWithoutE2e(),
          {
            __typename: "CheckRun",
            name: "E2E / PR Gate",
            workflowName: "Automation / Request NVSkills CI",
            detailsUrl: "https://github.com/NVIDIA/NemoClaw/runs/8001",
            startedAt: "2026-01-01T00:00:00Z",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
        ],
        coordinationCheckPages: [{ total_count: 0, check_runs: [] }],
        legacyCoordinationCheckPages: [{ total_count: 1, check_runs: [legacyCheck] }],
      }).stdout,
    );

    expect(output).toMatchObject({ allPass: true, gates: { ci: { pass: true } } });
  });

  it("finds the exact E2E coordination check on a later page", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        coordinationCheckPages: [
          {
            total_count: 2,
            check_runs: [coordinationCheck({ id: 8001, external_id: "ordinary-uuid" })],
          },
          { total_count: 2, check_runs: [coordinationCheck({ id: 8002 })] },
        ],
      }).stdout,
    );

    expect(output).toMatchObject({ allPass: true, gates: { ci: { pass: true } } });
  });

  it.each([
    ["missing", [{ total_count: 0, check_runs: [] }]],
    [
      "bound to another diff",
      [
        {
          total_count: 1,
          check_runs: [coordinationCheck({ external_id: `${E2E_COORDINATION_EXTERNAL_ID}-stale` })],
        },
      ],
    ],
    [
      "reported on another head SHA",
      [{ total_count: 1, check_runs: [coordinationCheck({ head_sha: "c".repeat(40) })] }],
    ],
    [
      "claimed by another GitHub App",
      [{ total_count: 1, check_runs: [coordinationCheck({ app: { id: 1234 } })] }],
    ],
    [
      "still running",
      [
        {
          total_count: 1,
          check_runs: [coordinationCheck({ status: "in_progress", conclusion: null })],
        },
      ],
    ],
    [
      "completed with failure",
      [
        {
          total_count: 1,
          check_runs: [coordinationCheck({ status: "completed", conclusion: "failure" })],
        },
      ],
    ],
    [
      "reported with malformed timing",
      [{ total_count: 1, check_runs: [coordinationCheck({ started_at: "not-a-time" })] }],
    ],
    [
      "reported with inverted timing",
      [
        {
          total_count: 1,
          check_runs: [
            coordinationCheck({
              started_at: "2026-01-01T00:02:30Z",
              completed_at: "2026-01-01T00:01:30Z",
            }),
          ],
        },
      ],
    ],
    [
      "duplicated",
      [
        {
          total_count: 2,
          check_runs: [coordinationCheck(), coordinationCheck({ id: 8001 })],
        },
      ],
    ],
    ["from an incomplete page set", [{ total_count: 2, check_runs: [coordinationCheck()] }]],
  ])("fails closed when PR/base SHA E2E coordination evidence is %s", (_name, pages) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        coordinationCheckPages: pages,
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["E2E / PR Gate: latest attempt evidence incomplete"],
    });
  });

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
    const result = runGate(
      e2eRunFixture(
        [
          [400, 40, "SUCCESS"],
          [401, 41, "SKIPPED"],
        ],
        {
          "400": {
            ...exactDiffGateRun("success", [{ id: 40, name: "E2E / PR Gate" }]),
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
      ),
    );

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
  it("keeps substantive PR CI ahead of a later metadata-only edit run", () => {
    const checkRun = (
      name: string,
      runId: number,
      jobId: number,
      conclusion: string,
      startedAt: string,
    ) => ({
      __typename: "CheckRun",
      name,
      workflowName: "CI / Pull Request",
      detailsUrl: `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}/job/${jobId}`,
      startedAt,
      status: "COMPLETED",
      conclusion,
    });
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [
        ...successfulRequiredChecks().filter((check) => check.name !== "checks"),
        checkRun("static-checks", 800, 3, "FAILURE", "2026-01-01T00:00:00Z"),
        checkRun("checks", 800, 11, "FAILURE", "2026-01-01T00:00:00Z"),
        checkRun("static-checks", 801, 3, "SKIPPED", "2026-01-01T00:02:00Z"),
        checkRun("checks", 801, 11, "SUCCESS", "2026-01-01T00:02:00Z"),
      ],
      actionRunAttempts: {
        "800": prWorkflowRun(
          "failure",
          prWorkflowJobs("success", {
            changes: { conclusion: "success" },
            "static-checks": { conclusion: "failure" },
            checks: { conclusion: "failure" },
          }),
          true,
        ),
        "801": prWorkflowRun(
          "success",
          prWorkflowJobs("skipped", {
            checks: { conclusion: "success" },
            changes: { conclusion: "skipped" },
          }),
          false,
        ),
      },
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci.pass).toBe(false);
    expect(output.gates.ci.failingChecks).toEqual(
      expect.arrayContaining(["static-checks: FAILURE", "checks: FAILURE"]),
    );
    expect(output.allPass).toBe(false);

    const invalidShapeResult = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [
        ...successfulRequiredChecks().filter((check) => check.name !== "checks"),
        checkRun("static-checks", 810, 3, "SUCCESS", "2026-01-01T00:00:00Z"),
        checkRun("checks", 810, 11, "SUCCESS", "2026-01-01T00:00:00Z"),
        checkRun("static-checks", 811, 3, "SKIPPED", "2026-01-01T00:02:00Z"),
        checkRun("checks", 811, 11, "SUCCESS", "2026-01-01T00:02:00Z"),
      ],
      actionRunAttempts: {
        "810": prWorkflowRun("success", prWorkflowJobs("success", {}), true),
        "811": prWorkflowRun(
          "success",
          prWorkflowJobs("skipped", { checks: { conclusion: "success" } }).filter(
            (job) => job.name !== "plugin-tests",
          ),
          false,
        ),
      },
    });

    const invalidShapeOutput = JSON.parse(invalidShapeResult.stdout);
    expect(invalidShapeOutput.gates.ci).toMatchObject({ pass: false });
    expect(invalidShapeOutput.gates.ci.failingChecks).toEqual(
      expect.arrayContaining([
        "static-checks: latest attempt evidence incomplete",
        "checks: latest attempt evidence incomplete",
      ]),
    );

    const unexpectedJobResult = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [
        ...successfulRequiredChecks().filter((check) => check.name !== "checks"),
        checkRun("static-checks", 812, 3, "SUCCESS", "2026-01-01T00:00:00Z"),
        checkRun("checks", 812, 11, "SUCCESS", "2026-01-01T00:00:00Z"),
        checkRun("static-checks", 813, 3, "SKIPPED", "2026-01-01T00:02:00Z"),
        checkRun("checks", 813, 11, "SUCCESS", "2026-01-01T00:02:00Z"),
      ],
      actionRunAttempts: {
        "812": prWorkflowRun("success", prWorkflowJobs("success", {}), true),
        "813": prWorkflowRun(
          "success",
          [
            ...prWorkflowJobs("skipped", { checks: { conclusion: "success" } }),
            { id: 12, name: "unexpected-job", conclusion: "success" },
          ],
          false,
        ),
      },
    });

    expect(JSON.parse(unexpectedJobResult.stdout).gates.ci.failingChecks).toEqual(
      expect.arrayContaining([
        "static-checks: latest attempt evidence incomplete",
        "checks: latest attempt evidence incomplete",
      ]),
    );
  });

  it("fails closed when a gate-false metadata run omits or duplicates a sentinel job", () => {
    const metadataJobs = prWorkflowJobs("skipped", {
      checks: { conclusion: "success" },
    });
    const malformedRuns = [
      metadataJobs.filter((job) => job.name !== "changes"),
      [...metadataJobs, { id: 12, name: "checks", conclusion: "success" }],
    ];

    for (const jobs of malformedRuns) {
      const output = JSON.parse(
        runGate({
          body: "Signed-off-by: Example User <user@example.com>",
          verified: true,
          statusChecks: [
            ...successfulRequiredChecks().filter(
              (check) => check.name !== "checks" && check.name !== "changes",
            ),
            e2eGateCheck([90, 11, "SUCCESS", undefined, undefined, "CI / Pull Request", "checks"]),
            e2eGateCheck([90, 1, "SUCCESS", undefined, undefined, "CI / Pull Request", "changes"]),
          ],
          actionRunAttempts: { "90": prWorkflowRun("success", jobs, false) },
        }).stdout,
      );

      expect(output.gates.ci).toMatchObject({ pass: false });
      expect(output.gates.ci.failingChecks).toEqual(
        expect.arrayContaining([
          "checks: latest attempt evidence incomplete",
          "changes: latest attempt evidence incomplete",
        ]),
      );
    }
  });

  it("drops an unexpanded metadata-only job when an expanded substantive run exists", () => {
    const prWorkflowJobs = (expandedMatrixName = false): ActionJobFixture[] =>
      [
        "changes",
        "docs-only-checks",
        "static-checks",
        "build-typecheck",
        "installer-integration",
        "wechat-runtime-audit",
        "reviewed-npm-audit",
        expandedMatrixName ? "cli-test-shards (1)" : "cli-test-shards",
        "cli-tests",
        "plugin-tests",
        "checks",
      ].map((name, index) => ({ id: index + 1, name }));
    const checkRun = (name: string, runId: number, jobId: number, conclusion: string) => ({
      __typename: "CheckRun",
      name,
      workflowName: "CI / Pull Request",
      detailsUrl: `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}/job/${jobId}`,
      startedAt: runId === 820 ? "2026-01-01T00:00:00Z" : "2026-01-01T00:02:00Z",
      status: "COMPLETED",
      conclusion,
    });
    const metadataJobs = prWorkflowJobs().map((job) => ({
      ...job,
      conclusion: job.name === "checks" ? "success" : "skipped",
    }));
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [
        ...successfulRequiredChecks(),
        checkRun("cli-test-shards (1)", 820, 8, "SUCCESS"),
        checkRun("cli-test-shards", 821, 8, "SKIPPED"),
      ],
      actionRunAttempts: {
        "820": prWorkflowRun("success", prWorkflowJobs(true), true),
        "821": prWorkflowRun("success", metadataJobs, false),
      },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it("keeps a later run when only the grouped job was skipped", () => {
    const result = runGate(
      e2eRunFixture(
        [
          [410, 40, "SUCCESS"],
          [411, 41, "SKIPPED"],
        ],
        {
          "410": exactDiffGateRun("success", [{ id: 40, name: "E2E / PR Gate" }]),
          "411": exactDiffGateRun("success", [
            { id: 41, name: "E2E / PR Gate", conclusion: "skipped" },
            { id: 42, name: "initialize" },
          ]),
        },
      ),
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false, failingChecks: ["E2E / PR Gate: SKIPPED"] } },
    });
  });

  it.each([
    {
      name: "keeps current-diff evidence ahead of a later nonmatching run",
      checks: e2eChecks([420, 40, "FAILURE"], [421, 41, "SUCCESS"]),
      runs: {
        "420": exactDiffGateRun("failure", [{ id: 40, name: "E2E / PR Gate" }]),
        "421": {
          ...exactDiffGateRun("success", [{ id: 41, name: "E2E / PR Gate" }]),
          headSha: "stale",
        },
      } as Record<string, ActionRunFixture>,
      failingChecks: ["E2E / PR Gate: FAILURE"],
    },
    {
      name: "fails closed on a later run with unknown diff identity",
      checks: e2eChecks([430, 40, "SUCCESS"], [431, 41, "SUCCESS"]),
      runs: {
        "430": exactDiffGateRun("success", [{ id: 40, name: "E2E / PR Gate" }]),
        "431": { attempt: 1, jobs: [{ id: 41, name: "E2E / PR Gate" }] },
      } as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects a singleton check from an older run attempt",
      checks: e2eChecks([440, 41, "SUCCESS"]),
      runs: {
        "440": exactDiffGateRun("success", [{ id: 42, name: "E2E / PR Gate" }]),
      } as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects a singleton check from a stale PR diff",
      checks: e2eChecks([442, 41, "SUCCESS"]),
      runs: {
        "442": {
          ...exactDiffGateRun("success", e2eJobs(41)),
          headSha: "stale",
          pullRequestHeadSha: HEAD_SHA,
        },
      } as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects an optional Actions check from a stale PR diff",
      checks: e2eChecks(
        [442, 41, "SUCCESS"],
        [443, 43, "SUCCESS", undefined, undefined, undefined, "optional-check"],
      ),
      runs: {
        "442": exactDiffGateRun("success", e2eJobs(41)),
        "443": {
          ...exactDiffGateRun("success", [{ id: 43, name: "optional-check" }]),
          headSha: "stale",
          pullRequestHeadSha: HEAD_SHA,
        },
      } as Record<string, ActionRunFixture>,
      failingChecks: ["optional-check: latest attempt evidence incomplete"],
    },
    {
      name: "rejects a singleton Actions check with a malformed URL",
      checks: e2eChecks([470, 41, "SUCCESS", undefined, "malformed"]),
      runs: {} as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects a required native check with no workflow or URL identity",
      checks: e2eChecks([474, 41, "SUCCESS", undefined, "", ""]),
      runs: {} as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects a required native check with a custom check-run URL",
      checks: e2eChecks([475, 41, "SUCCESS", undefined, CUSTOM_RUN_URL, "CodeQL"]),
      runs: {} as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects duplicate Actions checks when one URL is malformed",
      checks: e2eChecks([472, 40, "SUCCESS"], [473, 41, "SUCCESS", undefined, "malformed"]),
      runs: {} as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects PR/base SHA runs with different workflow identities",
      checks: e2eChecks([480, 40, "FAILURE"], [481, 41, "SUCCESS"]),
      runs: {
        "480": {
          ...exactDiffGateRun("failure", e2eJobs(40)),
          createdAt: "2026-01-01T00:00:00Z",
        },
        "481": {
          ...exactDiffGateRun("success", e2eJobs(41)),
          createdAt: "2026-01-01T00:01:00Z",
          path: ".github/workflows/unrelated.yaml",
        },
      } as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects a PR/base SHA run with a null workflow path",
      checks: e2eChecks([482, 41, "SUCCESS"]),
      runs: {
        "482": { ...exactDiffGateRun("success", e2eJobs(41)), path: undefined },
      } as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects jobs when a newer run attempt starts during collection",
      checks: e2eChecks([490, 41, "SUCCESS"]),
      runs: {
        "490": { ...exactDiffGateRun("success", e2eJobs(41)), nextAttempt: 2 },
      } as Record<string, ActionRunFixture>,
    },
    {
      name: "validates latest-attempt jobs for tied workflow runs",
      checks: e2eChecks(
        [445, 40, "SUCCESS", "2026-01-01T00:00:00Z"],
        [446, 41, "SUCCESS", "2026-01-01T00:00:00Z"],
      ),
      runs: {
        "445": exactDiffGateRun("success", [{ id: 42, name: "E2E / PR Gate" }]),
        "446": exactDiffGateRun("success", [{ id: 43, name: "E2E / PR Gate" }]),
      } as Record<string, ActionRunFixture>,
    },
    {
      name: "fails closed when prior conclusions are invalid or incomplete",
      checks: e2eChecks(
        [450, 40, "SUCCESS"],
        [452, 42, "SUCCESS"],
        [453, 43, "SUCCESS"],
        [451, 41, "SKIPPED"],
      ),
      runs: {
        "450": exactDiffGateRun("mystery", e2eJobs(40)),
        "452": exactDiffGateRun("success", [
          { id: 42, name: "E2E / PR Gate", conclusion: "mystery" },
        ]),
        "453": exactDiffGateRun("success", [{ id: 43, name: "E2E / PR Gate", conclusion: null }]),
        "451": exactDiffGateRun("skipped", [
          { id: 41, name: "E2E / PR Gate", conclusion: "skipped" },
        ]),
      } as Record<string, ActionRunFixture>,
      failingChecks: ["E2E / PR Gate: SKIPPED"],
    },
  ])("$name", ({ checks, runs, failingChecks = INCOMPLETE_E2E }) => {
    const result = runGate(e2eRunFixture(checks, runs));
    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false, failingChecks } },
    });
  });
  it("paginates every job before selecting the latest run attempt", () => {
    const firstPage = Array.from({ length: 100 }, (_value, index) => ({
      id: index + 20,
      name: `unrelated-job-${index}`,
    }));
    const result = runGate(
      e2eRunFixture(
        [
          [500, 10, "FAILURE"],
          [500, 120, "SUCCESS"],
        ],
        {
          "500": {
            ...exactDiffGateRun("success", [], 2),
            jobPages: [firstPage, [{ id: 120, name: "E2E / PR Gate" }]],
          },
        },
      ),
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });
  it("fails closed when a latest-attempt job is absent from the PR rollup", () => {
    const result = runGate(
      e2eRunFixture(
        [
          [600, 10, "SUCCESS"],
          [600, 20, "SUCCESS"],
        ],
        {
          "600": exactDiffGateRun("success", e2eJobs(20, 21), 2),
        },
      ),
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: false,
      gates: {
        ci: {
          pass: false,
          failingChecks: ["E2E / PR Gate: latest attempt evidence incomplete"],
        },
      },
    });
  });
  it.each([
    "",
    "1",
    "2026-02-30T00:00:00Z",
  ])("fails closed on invalid check-run ordering timestamp '%s'", (timestamp) => {
    const result = runGate(
      e2eRunFixture(
        [
          [700, 1, "SUCCESS", timestamp],
          [701, 2, "SUCCESS", timestamp],
        ],
        {
          "700": exactDiffGateRun("success", [{ id: 1, name: "E2E / PR Gate" }]),
          "701": exactDiffGateRun("success", [{ id: 2, name: "E2E / PR Gate" }]),
        },
      ),
    );

    expect(JSON.parse(result.stdout).gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["E2E / PR Gate: latest attempt evidence incomplete"],
    });
  });
});
