// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  readHermesDashboardWorkflow,
  validateHermesDashboardWorkflow,
  validateHermesDashboardWorkflowBoundary,
} from "../../../tools/e2e-scenarios/hermes-dashboard-workflow-boundary.mts";
import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

describe("Hermes dashboard workflow boundary", () => {
  it("runs by default and through either selective dispatch input", () => {
    const inventory = readFreeStandingJobsInventory();
    expect(validateHermesDashboardWorkflowBoundary()).toEqual([]);
    expect(inventory.scenarioToJob.get("hermes-dashboard")).toBe("hermes-dashboard-vitest");

    for (const selector of [
      { scenarios: "hermes-dashboard" },
      { jobs: "hermes-dashboard-vitest" },
    ]) {
      expect(evaluateE2eVitestWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveScenariosRuns: false,
        selectedFreeStandingJobs: ["hermes-dashboard-vitest"],
      });
    }
    expect(evaluateE2eVitestWorkflowDispatchSelectors({}).selectedFreeStandingJobs).toContain(
      "hermes-dashboard-vitest",
    );
  });

  it("rejects dashboard mode, execution, and reporting drift", () => {
    const dashboardMode = readHermesDashboardWorkflow();
    dashboardMode.jobs["hermes-dashboard-vitest"].env!.NEMOCLAW_E2E_HERMES_DASHBOARD = "0";
    expect(validateHermesDashboardWorkflow(dashboardMode)).toContain(
      "hermes-dashboard-vitest must enable Hermes dashboard coverage",
    );

    const execution = readHermesDashboardWorkflow();
    execution.jobs["hermes-dashboard-vitest"].steps!.find(
      (step) => step.name === "Run Hermes dashboard live Vitest test",
    )!.run = "echo skipped";
    expect(validateHermesDashboardWorkflow(execution)).toContain(
      "hermes-dashboard-vitest must run the live Vitest project",
    );

    const reporting = readHermesDashboardWorkflow();
    reporting.jobs["report-to-pr"].needs = [];
    expect(validateHermesDashboardWorkflow(reporting)).toContain(
      "report-to-pr must wait for hermes-dashboard-vitest",
    );
  });
});
