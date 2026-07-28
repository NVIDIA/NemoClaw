// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  readHermesDashboardWorkflow,
  validateHermesDashboardWorkflow,
  validateHermesDashboardWorkflowBoundary,
} from "../../../tools/e2e/hermes-dashboard-workflow-boundary.mts";

describe("Hermes dashboard workflow boundary", () => {
  it("keeps dashboard coverage in the canonical Hermes lane", () => {
    expect(validateHermesDashboardWorkflowBoundary()).toEqual([]);

    const workflow = readHermesDashboardWorkflow();
    const canonicalJob = workflow.jobs["hermes-e2e"];
    canonicalJob.env!.NEMOCLAW_E2E_HERMES_DASHBOARD = "0";
    canonicalJob.env!.NEMOCLAW_E2E_INFERENCE_MODE = "mock";
    canonicalJob.env!.E2E_TARGET_ID = "hermes-dashboard";
    canonicalJob.steps!.find((step) => step.name === "Run Hermes live Vitest test")!.run =
      "echo skipped";
    workflow.jobs["hermes-dashboard"] = structuredClone(canonicalJob);
    workflow.jobs["hermes-discord"].env!.NEMOCLAW_E2E_HERMES_DASHBOARD = "1";
    workflow.jobs["report-to-pr"].needs = ["hermes-dashboard"];

    expect(validateHermesDashboardWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "hermes-dashboard must remain consolidated into hermes-e2e",
        "only hermes-e2e may enable Hermes dashboard E2E coverage (found on hermes-discord)",
        "hermes-e2e must enable Hermes dashboard coverage",
        "hermes-e2e must preserve manual inference-mode selection",
        "hermes-e2e must publish its canonical selector",
        "hermes-e2e must run the live Vitest project",
        "report-to-pr must wait for hermes-e2e",
        "report-to-pr must not wait for retired hermes-dashboard",
      ]),
    );
  });

  it("keeps the canonical checkout trust boundary", () => {
    const workflow = readHermesDashboardWorkflow();
    const checkout = workflow.jobs["hermes-e2e"].steps!.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    )!;
    checkout.uses = "actions/checkout@v6";
    checkout.with!["persist-credentials"] = true;

    expect(validateHermesDashboardWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "hermes-e2e checkout must pin a full action SHA",
        "hermes-e2e checkout must disable persisted credentials",
      ]),
    );
  });
});
