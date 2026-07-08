// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  evaluateE2eWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
} from "../../../tools/e2e/workflow-boundary.mts";

describe("rlimit connect workflow boundary", () => {
  it("maps the rlimit connect acceptance selector to its explicit Vitest job", () => {
    const inventory = readFreeStandingJobsInventory();
    expect(inventory.allowedJobs).toContain("sandbox-rlimits-connect");
    expect(inventory.explicitOnlyJobs).toContain("sandbox-rlimits-connect");
    expect(inventory.targetToJob.get("sandbox-rlimits-connect")).toBe("sandbox-rlimits-connect");

    expect(
      evaluateE2eWorkflowDispatchSelectors({ targets: "sandbox-rlimits-connect" }),
    ).toMatchObject({
      valid: true,
      liveTargetsRun: false,
      selectedFreeStandingJobs: ["sandbox-rlimits-connect"],
      registryTargets: [],
    });
    expect(evaluateE2eWorkflowDispatchSelectors({ jobs: "sandbox-rlimits-connect" })).toMatchObject(
      {
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["sandbox-rlimits-connect"],
        registryTargets: [],
      },
    );
    expect(
      evaluateE2eWorkflowDispatchSelectors({ jobs: "", targets: "" }).selectedFreeStandingJobs,
    ).not.toContain("sandbox-rlimits-connect");
  });
});
