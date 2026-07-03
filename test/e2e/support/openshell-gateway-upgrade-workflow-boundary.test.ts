// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  evaluateE2eWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateFreeStandingWorkflowInventory,
} from "../../../tools/e2e/workflow-boundary.mts";

describe("OpenShell gateway upgrade workflow boundary", () => {
  it("routes selector inputs to the free-standing E2E job", () => {
    expect(
      evaluateE2eWorkflowDispatchSelectors({
        targets: "openshell-gateway-upgrade",
      }),
    ).toMatchObject({
      valid: true,
      liveTargetsRun: false,
      selectedFreeStandingJobs: ["openshell-gateway-upgrade"],
      registryTargets: [],
    });
    expect(
      evaluateE2eWorkflowDispatchSelectors({
        jobs: "openshell-gateway-upgrade",
      }),
    ).toMatchObject({
      valid: true,
      liveTargetsRun: false,
      selectedFreeStandingJobs: ["openshell-gateway-upgrade"],
      registryTargets: [],
    });
  });

  it("derives the free-standing inventory metadata from the workflow", () => {
    const inventory = readFreeStandingJobsInventory();

    expect(validateFreeStandingWorkflowInventory()).toEqual([]);
    expect(inventory.allowedJobs).toContain("openshell-gateway-upgrade");
    expect(inventory.targetToJob.get("openshell-gateway-upgrade")).toBe(
      "openshell-gateway-upgrade",
    );
  });
});
