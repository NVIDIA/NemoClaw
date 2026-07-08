// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  evaluateE2eWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
} from "../../../tools/e2e/workflow-boundary.mts";

describe("overlayfs-autofix workflow boundary", () => {
  it("maps overlayfs-autofix selectors to the free-standing E2E job", () => {
    expect(
      evaluateE2eWorkflowDispatchSelectors({
        targets: "overlayfs-autofix",
      }),
    ).toMatchObject({
      valid: true,
      liveTargetsRun: false,
      selectedFreeStandingJobs: ["overlayfs-autofix"],
      registryTargets: [],
    });
    expect(
      evaluateE2eWorkflowDispatchSelectors({
        jobs: "overlayfs-autofix",
      }),
    ).toMatchObject({
      valid: true,
      liveTargetsRun: false,
      selectedFreeStandingJobs: ["overlayfs-autofix"],
      registryTargets: [],
    });
  });

  it("derives overlayfs-autofix from workflow free-standing metadata", () => {
    const inventory = readFreeStandingJobsInventory();

    expect(inventory.allowedJobs).toContain("overlayfs-autofix");
    expect(inventory.targetToJob.get("overlayfs-autofix")).toBe("overlayfs-autofix");
  });
});
