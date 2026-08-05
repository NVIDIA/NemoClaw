// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ActionJobFixture, ActionRunFixture } from "./check-gates-test-fixtures.ts";
import {
  CUSTOM_RUN_URL,
  e2eChecks,
  e2eGateCheck,
  e2eJobs,
  e2eRunFixture,
  exactDiffGateRun,
  HEAD_SHA,
  INCOMPLETE_E2E,
  prWorkflowJobs,
  prWorkflowRun,
  runGate,
  successfulRequiredChecks,
} from "./check-gates-test-fixtures.ts";

describe("maintainer merge-gate contributor compliance", () => {
  it("retains failing CI from a code-changing PR run after a later metadata-only run is canceled", () => {
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
          "cancelled",
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
