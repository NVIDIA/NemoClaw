// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildExecutionProfileMatrix } from "../../../tools/e2e/execution-profile.mts";
import { readFreeStandingJobsInventory } from "../../../tools/e2e/workflow-boundary.mts";
import { buildE2eWorkflowPlan, runE2eWorkflowPlanCli } from "../../../tools/e2e/workflow-plan.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { buildLiveTargetMatrix } from "../registry/run.ts";

const PLANNER_CLI = path.join(REPO_ROOT, "tools", "e2e", "workflow-plan.mts");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

function firstId<T extends { id: string }>(rows: readonly T[], label: string): string {
  expect(rows, `expected at least one ${label}`).not.toHaveLength(0);
  return rows[0]!.id;
}

describe("E2E workflow plan", () => {
  it("defaults to every supported registry target and discovered hermetic test", () => {
    const plan = buildE2eWorkflowPlan();

    expect(plan).toEqual({
      matrix: buildLiveTargetMatrix(),
      hermeticMatrix: buildExecutionProfileMatrix(),
      hermesSelected: true,
      explicitOnlyJobs: readFreeStandingJobsInventory().explicitOnlyJobs,
    });
  });

  it("validates logical jobs and selects only matching hermetic tests", () => {
    const hermeticId = firstId(buildExecutionProfileMatrix(), "hermetic test");
    const plan = buildE2eWorkflowPlan({ jobs: `${hermeticId},hermes-e2e` });

    expect(plan.matrix).toEqual([]);
    expect(plan.hermeticMatrix.map((row) => row.id)).toEqual([hermeticId]);
    expect(plan.hermesSelected).toBe(true);
  });

  it("routes a registry target into the live matrix", () => {
    const registryId = firstId(buildLiveTargetMatrix(), "supported registry target");
    const plan = buildE2eWorkflowPlan({ targets: registryId });

    expect(plan.matrix.map((row) => row.id)).toEqual([registryId]);
    expect(plan.hermeticMatrix).toEqual([]);
    expect(plan.hermesSelected).toBe(false);
  });

  it("partitions mixed registry and discovered free-standing targets", () => {
    const registryId = firstId(buildLiveTargetMatrix(), "supported registry target");
    const hermeticId = firstId(buildExecutionProfileMatrix(), "hermetic test");
    const plan = buildE2eWorkflowPlan({ targets: `${registryId},${hermeticId}` });

    expect(plan.matrix.map((row) => row.id)).toEqual([registryId]);
    expect(plan.hermeticMatrix.map((row) => row.id)).toEqual([hermeticId]);
  });

  it("rejects an unknown logical job", () => {
    expect(() => buildE2eWorkflowPlan({ jobs: "definitely-unknown-e2e-job" })).toThrow(
      "Unknown free-standing E2E job: definitely-unknown-e2e-job",
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

  it("rejects simultaneous jobs and targets", () => {
    expect(() => buildE2eWorkflowPlan({ jobs: "hermes-e2e", targets: "hermes-e2e" })).toThrow(
      "Use either jobs or targets, not both",
    );
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
      "hermeticMatrix",
      "hermesSelected",
      "explicitOnlyJobs",
    ]);
    expect(output).toBe(`${JSON.stringify(parsed)}\n`);
  });

  it("reports CLI failures as workflow annotations", () => {
    const result = spawnSync(
      TSX,
      [PLANNER_CLI, "--jobs", "hermes-e2e", "--targets", "hermes-e2e"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("::error::Use either jobs or targets, not both\n");
  });
});
