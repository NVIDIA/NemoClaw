// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  readHermesDashboardWorkflow,
  validateHermesDashboardWorkflow,
  validateHermesDashboardWorkflowBoundary,
} from "../../../tools/e2e/hermes-dashboard-workflow-boundary.mts";

describe("Hermes dashboard workflow boundary", () => {
  it("accepts the checked-in workflow and rejects dashboard mode, execution, and reporting drift", () => {
    expect(validateHermesDashboardWorkflowBoundary()).toEqual([]);
    const dashboardMode = readHermesDashboardWorkflow();
    const dashboardJob = dashboardMode.jobs["hermes-dashboard"];
    dashboardJob["timeout-minutes"] = 30;
    dashboardJob.env!.E2E_ARTIFACT_DIR = "/tmp/hermes-dashboard";
    dashboardJob.env!.NEMOCLAW_E2E_HERMES_DASHBOARD = "0";
    dashboardJob.env!.NVIDIA_INFERENCE_API_KEY = "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";
    const checkout = dashboardJob.steps!.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    )!;
    checkout.uses = "actions/checkout@v6";
    checkout.with!["persist-credentials"] = true;
    expect(validateHermesDashboardWorkflow(dashboardMode)).toEqual(
      expect.arrayContaining([
        "hermes-dashboard timeout must be 75 minutes",
        "hermes-dashboard must use its isolated artifact directory",
        "hermes-dashboard must enable Hermes dashboard coverage",
        "hermes-dashboard must not expose the inference key at job scope",
        "hermes-dashboard checkout must pin a full action SHA",
        "hermes-dashboard checkout must disable persisted credentials",
      ]),
    );

    const misplacedDashboardMode = readHermesDashboardWorkflow();
    misplacedDashboardMode.jobs["hermes-e2e"].env!.NEMOCLAW_E2E_HERMES_DASHBOARD = "1";
    expect(validateHermesDashboardWorkflow(misplacedDashboardMode)).toContain(
      "only hermes-dashboard may enable Hermes dashboard E2E coverage (found on hermes-e2e)",
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
