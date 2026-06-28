// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateE2eVitestScenariosWorkflowBoundary,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

describe("sandbox operations workflow boundary", () => {
  it("runs by default and through either selective dispatch input", () => {
    const inventory = readFreeStandingJobsInventory();
    expect(validateE2eVitestScenariosWorkflowBoundary()).toEqual([]);
    expect(inventory.scenarioToJob.get("sandbox-operations")).toBe("sandbox-operations-vitest");

    for (const selector of [
      { scenarios: "sandbox-operations" },
      { jobs: "sandbox-operations-vitest" },
    ]) {
      expect(evaluateE2eVitestWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveScenariosRuns: false,
        selectedFreeStandingJobs: ["sandbox-operations-vitest"],
      });
    }
    expect(evaluateE2eVitestWorkflowDispatchSelectors({}).selectedFreeStandingJobs).toContain(
      "sandbox-operations-vitest",
    );
  });
});
