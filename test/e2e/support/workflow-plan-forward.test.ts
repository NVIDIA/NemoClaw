// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { catalogueTargetsForChangedFiles } from "../../../tools/e2e/target-catalogue.mts";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";

describe("E2E forward workflow plan", () => {
  it.each([
    "src/lib/adapters/openshell/command-execution.ts",
    "src/lib/adapters/openshell/forward-cli.ts",
    "src/lib/adapters/openshell/forward-runtime.ts",
    "src/lib/adapters/openshell/forward.ts",
    "src/lib/agent/hermes-api-forward.ts",
    "src/lib/onboard/agent-dashboard-forward.ts",
    "src/lib/onboard/dashboard.ts",
    "src/lib/onboard/dashboard-runtime.ts",
  ])("selects OpenClaw and Hermes forward lifecycles when %s changes (#9808)", (changedFile) => {
    const targetIds = catalogueTargetsForChangedFiles([changedFile]).map((target) => target.id);

    expect(targetIds).toEqual([
      "dashboard-remote-bind",
      "double-onboard-hermes",
      "onboard-resume-hermes",
    ]);
    const plan = buildE2eWorkflowPlan({}, { changedFiles: [changedFile] });
    expect(plan.catalogueMatrices["nvidia-inference"].map((row) => row.id)).toContain(
      "dashboard-remote-bind",
    );
  });
});
