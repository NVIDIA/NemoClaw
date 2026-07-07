// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  evaluateE2eWorkflowDispatchSelectors,
  formatFreeStandingJobsInventoryForShell,
  readFreeStandingJobsInventory,
  validateE2eWorkflowBoundary,
  validateFreeStandingWorkflowInventory,
} from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract.ts";

describe("Jetson nvmap GPU E2E workflow boundary", () => {
  it("keeps Jetson selectable but excluded from full-suite dispatch", () => {
    const inventory = readFreeStandingJobsInventory();
    expect(validateE2eWorkflowBoundary()).toEqual([]);
    expect(inventory.allowedJobs).toContain("jetson-nvmap-gpu");
    expect(inventory.explicitOnlyJobs).toContain("jetson-nvmap-gpu");
    expect(formatFreeStandingJobsInventoryForShell(inventory)).toContain(
      "explicit_only_jobs_csv=openshell-gateway-auth-contract,mcp-bridge-dev,hermes-gpu-startup,sandbox-rlimits-connect,jetson-nvmap-gpu",
    );
    expect(inventory.targetToJob.get("jetson-nvmap-gpu")).toBe("jetson-nvmap-gpu");
    expect(evaluateE2eWorkflowDispatchSelectors({}).selectedFreeStandingJobs).not.toContain(
      "jetson-nvmap-gpu",
    );
  });

  it("rejects invalid explicit-only workflow metadata", () => {
    const workflow = readWorkflow();
    const jobs = workflow.jobs as Record<string, { env?: Record<string, unknown> }>;
    jobs["jetson-nvmap-gpu"].env!.E2E_DEFAULT_ENABLED = "yes";
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-explicit-only-"));
    const workflowPath = join(directory, "workflow.yaml");
    try {
      writeFileSync(workflowPath, YAML.stringify(workflow));
      expect(validateFreeStandingWorkflowInventory(workflowPath)).toContain(
        'jetson-nvmap-gpu job E2E_DEFAULT_ENABLED must be "0" when set',
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("runs Jetson only when explicitly selected", () => {
    for (const selector of [{ targets: "jetson-nvmap-gpu" }, { jobs: "jetson-nvmap-gpu" }]) {
      expect(evaluateE2eWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["jetson-nvmap-gpu"],
        registryTargets: [],
      });
    }
  });

  it("reports default jobs without claiming explicit-only Jetson ran", () => {
    expect(validateE2eWorkflowBoundary()).toEqual([]);
  });
});
