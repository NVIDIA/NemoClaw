// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateE2eVitestScenariosWorkflowBoundary,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

const WORKFLOW_PATH = path.join(process.cwd(), ".github/workflows/e2e-vitest-scenarios.yaml");

describe("Jetson nvmap GPU Vitest workflow boundary", () => {
  it("keeps Jetson selectable but excluded from full-suite dispatch", () => {
    const inventory = readFreeStandingJobsInventory();
    expect(validateE2eVitestScenariosWorkflowBoundary()).toEqual([]);
    expect(inventory.allowedJobs).toContain("jetson-nvmap-gpu-vitest");
    expect(inventory.scenarioToJob.get("jetson-nvmap-gpu")).toBe("jetson-nvmap-gpu-vitest");
    expect(evaluateE2eVitestWorkflowDispatchSelectors({}).selectedFreeStandingJobs).not.toContain(
      "jetson-nvmap-gpu-vitest",
    );
  });

  it("runs Jetson only when explicitly selected", () => {
    for (const selector of [
      { scenarios: "jetson-nvmap-gpu" },
      { jobs: "jetson-nvmap-gpu-vitest" },
    ]) {
      expect(evaluateE2eVitestWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveScenariosRuns: false,
        selectedFreeStandingJobs: ["jetson-nvmap-gpu-vitest"],
        registryScenarios: [],
      });
    }
  });

  it("reports default jobs without claiming explicit-only Jetson ran", () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, "utf8");
    expect(workflow).not.toContain("All jobs passed");
    expect(workflow).not.toContain("default — all free-standing when no scenarios are requested");
    expect(workflow).toContain("All default jobs passed");
    expect(workflow).toContain(
      "default — all default-enabled free-standing jobs; explicit-only jobs such as `jetson-nvmap-gpu-vitest` are skipped unless selected",
    );
  });
});
