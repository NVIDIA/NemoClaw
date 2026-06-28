// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

describe("rlimit connect workflow boundary", () => {
  it("maps the rlimit connect acceptance selector to its explicit Vitest job", () => {
    const inventory = readFreeStandingJobsInventory();
    expect(inventory.allowedJobs).toContain("sandbox-rlimits-connect-vitest");
    expect(inventory.scenarioToJob.get("sandbox-rlimits-connect")).toBe(
      "sandbox-rlimits-connect-vitest",
    );

    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "sandbox-rlimits-connect" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["sandbox-rlimits-connect-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ jobs: "sandbox-rlimits-connect-vitest" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["sandbox-rlimits-connect-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ jobs: "", scenarios: "" })
        .selectedFreeStandingJobs,
    ).not.toContain("sandbox-rlimits-connect-vitest");
  });
});
