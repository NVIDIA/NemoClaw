// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

describe("overlayfs-autofix workflow boundary", () => {
  it("maps overlayfs-autofix selectors to the free-standing Vitest job", () => {
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({
        scenarios: "overlayfs-autofix",
      }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["overlayfs-autofix-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({
        jobs: "overlayfs-autofix-vitest",
      }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["overlayfs-autofix-vitest"],
      registryScenarios: [],
    });
  });

  it("derives overlayfs-autofix from workflow free-standing metadata", () => {
    const inventory = readFreeStandingJobsInventory();

    expect(inventory.allowedJobs).toContain("overlayfs-autofix-vitest");
    expect(inventory.scenarioToJob.get("overlayfs-autofix")).toBe("overlayfs-autofix-vitest");
  });
});
