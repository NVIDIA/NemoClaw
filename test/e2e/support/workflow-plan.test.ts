// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { discoverCredentialFreeTests } from "../../../tools/e2e/credential-free-tests.mts";
import { readFreeStandingJobsInventory } from "../../../tools/e2e/workflow-boundary.mts";
import {
  buildE2eWorkflowPlan,
  renderE2eWorkflowPlanSummary,
  runE2eWorkflowPlanCli,
  validateE2eWorkflowPlan,
  writeE2eWorkflowPlanCiOutput,
} from "../../../tools/e2e/workflow-plan.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { buildLiveTargetMatrix } from "../registry/run.ts";

const PLANNER_CLI = path.join(REPO_ROOT, "tools", "e2e", "workflow-plan.mts");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

function firstId<T extends { id: string }>(rows: readonly T[], label: string): string {
  expect(rows, `expected at least one ${label}`).not.toHaveLength(0);
  return rows[0]!.id;
}

describe("E2E workflow plan", () => {
  it("defaults to every supported registry target and tagged credential-free test", () => {
    const plan = buildE2eWorkflowPlan();

    expect(plan).toEqual({
      matrix: buildLiveTargetMatrix(),
      testMatrix: discoverCredentialFreeTests(),
      hermesSelected: true,
      explicitOnlyJobs: readFreeStandingJobsInventory().explicitOnlyJobs,
    });
    expect(plan.explicitOnlyJobs).toContain("hermes-gpu-startup");
  });

  it("validates jobs and selects only matching credential-free tests", () => {
    const testId = firstId(discoverCredentialFreeTests(), "credential-free test");
    const plan = buildE2eWorkflowPlan({ jobs: `${testId},hermes-e2e` });

    expect(plan.matrix).toEqual([]);
    expect(plan.testMatrix.map((row) => row.id)).toEqual([testId]);
    expect(plan.hermesSelected).toBe(true);
  });

  it("routes a registry target into the live matrix", () => {
    const registryId = firstId(buildLiveTargetMatrix(), "supported registry target");
    const plan = buildE2eWorkflowPlan({ targets: registryId });

    expect(plan.matrix.map((row) => row.id)).toEqual([registryId]);
    expect(plan.testMatrix).toEqual([]);
    expect(plan.hermesSelected).toBe(false);
  });

  it("partitions mixed registry and tagged test targets", () => {
    const registryId = firstId(buildLiveTargetMatrix(), "supported registry target");
    const testId = firstId(discoverCredentialFreeTests(), "credential-free test");
    const plan = buildE2eWorkflowPlan({ targets: `${registryId},${testId}` });

    expect(plan.matrix.map((row) => row.id)).toEqual([registryId]);
    expect(plan.testMatrix.map((row) => row.id)).toEqual([testId]);
  });

  it("rejects an unknown job", () => {
    expect(() => buildE2eWorkflowPlan({ jobs: "definitely-unknown-e2e-job" })).toThrow(
      "Unknown E2E test ID: definitely-unknown-e2e-job",
    );
  });

  it("rejects an unknown target that belongs to neither inventory nor registry", () => {
    expect(() => buildE2eWorkflowPlan({ targets: "definitely-unknown-e2e-target" })).toThrow(
      "Unknown target 'definitely-unknown-e2e-target'",
    );
  });

  it.each([
    ["jobs", "alpha,,beta"],
    ["jobs", "alpha beta"],
    ["targets", "../escape"],
    ["targets", "alpha,"],
  ] as const)("rejects invalid %s input %s", (kind, value) => {
    expect(() => buildE2eWorkflowPlan({ [kind]: value })).toThrow(`Invalid ${kind} input`);
  });

  it("combines free-standing jobs and typed targets in one execution plan", () => {
    const registryId = firstId(buildLiveTargetMatrix(), "supported registry target");
    const plan = buildE2eWorkflowPlan({ jobs: "hermes-e2e", targets: registryId });

    expect(plan.matrix.map((row) => row.id)).toEqual([registryId]);
    expect(plan.testMatrix).toEqual([]);
    expect(plan.hermesSelected).toBe(true);
  });

  it("fails closed on malformed planner output", () => {
    const validPlan = buildE2eWorkflowPlan();
    const [registryRow] = validPlan.matrix;
    const [testRow] = validPlan.testMatrix;
    expect(registryRow).toBeDefined();
    expect(testRow).toBeDefined();
    const { explicitOnlyJobs: _omitted, ...missingField } = validPlan;
    const malformedPlans = [
      missingField,
      { ...validPlan, matrix: [...validPlan.matrix, { ...registryRow }] },
      { ...validPlan, testMatrix: [{ ...testRow, id: "invalid_id" }] },
      {
        ...validPlan,
        testMatrix: [{ ...testRow, project: "e2e-live", file: "test/e2e/live/../secret.test.ts" }],
      },
      { ...validPlan, testMatrix: [{ ...testRow, id: registryRow.id }] },
      { ...validPlan, hermesSelected: "false" },
    ];

    for (const plan of malformedPlans) {
      expect(() => validateE2eWorkflowPlan(plan)).toThrow(
        "E2E planner returned an invalid output schema",
      );
    }
  });

  it("writes byte-compatible GitHub outputs and the execution-plan summary", () => {
    const testId = firstId(discoverCredentialFreeTests(), "credential-free test");
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    const plan = buildE2eWorkflowPlan({ jobs: testId });
    try {
      writeE2eWorkflowPlanCiOutput(
        { jobs: testId },
        {
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
        },
      );

      expect(readFileSync(output, "utf8")).toBe(
        [
          `matrix=${JSON.stringify(plan.matrix)}`,
          `test_matrix=${JSON.stringify(plan.testMatrix)}`,
          "hermes_selected=false",
          `explicit_only_jobs=${plan.explicitOnlyJobs.join(",")}`,
          "",
        ].join("\n"),
      );
      expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(plan));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects an unsupported inference mode before writing CI output", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    try {
      expect(() =>
        writeE2eWorkflowPlanCiOutput(
          {},
          {
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            INFERENCE_MODE: "unsupported",
          },
        ),
      ).toThrow("Invalid inference_mode: unsupported");
      expect(existsSync(output)).toBe(false);
      expect(existsSync(summary)).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("emits one compact JSON line with the deterministic workflow-output schema", () => {
    let output = "";
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      runE2eWorkflowPlanCli(["--jobs", "hermes-e2e"]);
    } finally {
      process.stdout.write = write;
    }

    expect(output.endsWith("\n")).toBe(true);
    expect(output.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(output);
    expect(Object.keys(parsed)).toEqual([
      "matrix",
      "testMatrix",
      "hermesSelected",
      "explicitOnlyJobs",
    ]);
    expect(output).toBe(`${JSON.stringify(parsed)}\n`);
  });

  it("reports CLI failures as workflow annotations", () => {
    const result = spawnSync(
      TSX,
      [PLANNER_CLI, "--jobs", "hermes-e2e", "--targets", "definitely-unknown-e2e-target"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("::error::Unknown target 'definitely-unknown-e2e-target'");
  });

  it("writes CI outputs from the selector environment through the CLI", () => {
    const testId = firstId(discoverCredentialFreeTests(), "credential-free test");
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-cli-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    const plan = buildE2eWorkflowPlan({ jobs: testId });
    try {
      const result = spawnSync(TSX, [PLANNER_CLI, "--ci-output"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          JOBS: testId,
          TARGETS: "",
        },
        timeout: 30_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(
        [
          `matrix=${JSON.stringify(plan.matrix)}`,
          `test_matrix=${JSON.stringify(plan.testMatrix)}`,
          `hermes_selected=${plan.hermesSelected}`,
          `explicit_only_jobs=${plan.explicitOnlyJobs.join(",")}`,
          "",
        ].join("\n"),
      );
      expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(plan));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("writes controller-selected jobs and targets through the CI-output path (#7031)", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-cli-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    const target = "ubuntu-repo-cloud-langchain-deepagents-code";
    const plan = buildE2eWorkflowPlan({ jobs: "cloud-onboard", targets: target });
    try {
      const result = spawnSync(TSX, [PLANNER_CLI, "--ci-output"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          JOBS: "cloud-onboard",
          TARGETS: target,
        },
        timeout: 30_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(
        [
          `matrix=${JSON.stringify(plan.matrix)}`,
          `test_matrix=${JSON.stringify(plan.testMatrix)}`,
          `hermes_selected=${plan.hermesSelected}`,
          `explicit_only_jobs=${plan.explicitOnlyJobs.join(",")}`,
          "",
        ].join("\n"),
      );
      expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(plan));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
