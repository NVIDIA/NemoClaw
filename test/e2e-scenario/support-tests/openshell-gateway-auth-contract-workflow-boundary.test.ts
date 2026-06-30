// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateE2eVitestScenariosWorkflowBoundary,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

describe("OpenShell gateway auth contract workflow boundary", () => {
  it("keeps the auth contract job explicit-only", () => {
    const inventory = readFreeStandingJobsInventory();

    expect(validateE2eVitestScenariosWorkflowBoundary()).toEqual([]);
    expect(inventory.allowedJobs).toContain("openshell-gateway-auth-contract-vitest");
    expect(inventory.scenarioToJob.get("openshell-gateway-auth-contract")).toBe(
      "openshell-gateway-auth-contract-vitest",
    );
    expect(evaluateE2eVitestWorkflowDispatchSelectors({}).selectedFreeStandingJobs).not.toContain(
      "openshell-gateway-auth-contract-vitest",
    );
  });

  it("runs the auth contract job when explicitly selected", () => {
    for (const selector of [
      { scenarios: "openshell-gateway-auth-contract" },
      { jobs: "openshell-gateway-auth-contract-vitest" },
    ]) {
      expect(evaluateE2eVitestWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveScenariosRuns: false,
        selectedFreeStandingJobs: ["openshell-gateway-auth-contract-vitest"],
        registryScenarios: [],
      });
    }
  });

  it("rejects a default-dispatch report that omits the auth-contract selector", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-workflow-"));
    try {
      const workflowPath = path.join(tmpDir, "e2e-vitest-scenarios.yaml");
      const source = fs.readFileSync(".github/workflows/e2e-vitest-scenarios.yaml", "utf-8");
      fs.writeFileSync(
        workflowPath,
        source.replace(
          "job: 'openshell-gateway-auth-contract-vitest'",
          "job: 'omitted-openshell-gateway-auth-contract-vitest'",
        ),
        "utf-8",
      );

      expect(validateE2eVitestScenariosWorkflowBoundary(workflowPath)).toContain(
        "step 'Post Vitest scenario results to PR' run script must report default-excluded job openshell-gateway-auth-contract-vitest",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects automatic pull-request triggers for the dispatch-only workflow", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-workflow-"));
    try {
      const workflowPath = path.join(tmpDir, "e2e-vitest-scenarios.yaml");
      const source = fs.readFileSync(".github/workflows/e2e-vitest-scenarios.yaml", "utf-8");
      fs.writeFileSync(
        workflowPath,
        source.replace("on:\n  workflow_dispatch:", "on:\n  pull_request:\n  workflow_dispatch:"),
        "utf-8",
      );

      expect(validateE2eVitestScenariosWorkflowBoundary(workflowPath)).toContain(
        "workflow must not run on pull_request",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
