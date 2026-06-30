// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  readHermesDashboardWorkflow,
  validateHermesDashboardWorkflow,
  validateHermesDashboardWorkflowBoundary,
} from "../../../tools/e2e/hermes-dashboard-workflow-boundary.mts";
import {
  evaluateE2eWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
} from "../../../tools/e2e/workflow-boundary.mts";

describe("Hermes dashboard workflow boundary", () => {
  it("runs by default and through either selective dispatch input", () => {
    const inventory = readFreeStandingJobsInventory();
    expect(validateHermesDashboardWorkflowBoundary()).toEqual([]);
    expect(inventory.targetToJob.get("hermes-dashboard")).toBe("hermes-dashboard");

    for (const selector of [{ targets: "hermes-dashboard" }, { jobs: "hermes-dashboard" }]) {
      expect(evaluateE2eWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["hermes-dashboard"],
      });
    }
    expect(evaluateE2eWorkflowDispatchSelectors({}).selectedFreeStandingJobs).toContain(
      "hermes-dashboard",
    );
  });

  it("rejects dashboard mode, execution, and reporting drift", () => {
    const dashboardMode = readHermesDashboardWorkflow();
    dashboardMode.jobs["hermes-dashboard"].env!.NEMOCLAW_E2E_HERMES_DASHBOARD = "0";
    expect(validateHermesDashboardWorkflow(dashboardMode)).toContain(
      "hermes-dashboard must enable Hermes dashboard coverage",
    );

    const execution = readHermesDashboardWorkflow();
    execution.jobs["hermes-dashboard"].steps!.find(
      (step) => step.name === "Run Hermes dashboard live Vitest test",
    )!.run = "echo skipped";
    expect(validateHermesDashboardWorkflow(execution)).toContain(
      "hermes-dashboard must run the live Vitest project",
    );

    const reporting = readHermesDashboardWorkflow();
    reporting.jobs["report-to-pr"].needs = [];
    expect(validateHermesDashboardWorkflow(reporting)).toContain(
      "report-to-pr must wait for hermes-dashboard",
    );
  });
});
