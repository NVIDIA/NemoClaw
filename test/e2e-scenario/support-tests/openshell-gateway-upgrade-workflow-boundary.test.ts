// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateFreeStandingWorkflowInventory,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

describe("OpenShell gateway upgrade workflow boundary", () => {
  it("routes selector inputs to the free-standing Vitest job", () => {
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({
        scenarios: "openshell-gateway-upgrade",
      }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["openshell-gateway-upgrade-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({
        jobs: "openshell-gateway-upgrade-vitest",
      }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["openshell-gateway-upgrade-vitest"],
      registryScenarios: [],
    });
  });

  it("derives the free-standing inventory metadata from the workflow", () => {
    const inventory = readFreeStandingJobsInventory();

    expect(validateFreeStandingWorkflowInventory()).toEqual([]);
    expect(inventory.allowedJobs).toContain("openshell-gateway-upgrade-vitest");
    expect(inventory.scenarioToJob.get("openshell-gateway-upgrade")).toBe(
      "openshell-gateway-upgrade-vitest",
    );
  });
});
