// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  readSandboxOperationsWorkflow,
  validateSandboxOperationsWorkflow,
  validateSandboxOperationsWorkflowBoundary,
} from "../../../tools/e2e-scenarios/sandbox-operations-workflow-boundary.mts";
import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

describe("sandbox operations workflow boundary", () => {
  it("runs by default and through either selective dispatch input", () => {
    const inventory = readFreeStandingJobsInventory();
    expect(validateSandboxOperationsWorkflowBoundary()).toEqual([]);
    expect(inventory.scenarioToJob.get("sandbox-operations")).toBe("sandbox-operations-vitest");

    for (const selector of [
      { scenarios: "sandbox-operations" },
      { jobs: "sandbox-operations-vitest" },
    ]) {
      expect(evaluateE2eVitestWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveScenariosRuns: false,
        selectedFreeStandingJobs: ["sandbox-operations-vitest"],
      });
    }
    expect(evaluateE2eVitestWorkflowDispatchSelectors({}).selectedFreeStandingJobs).toContain(
      "sandbox-operations-vitest",
    );
  });

  it("rejects workspace-scoped auth, unsanitized installs, and broad inference secrets", () => {
    const workspaceAuth = readSandboxOperationsWorkflow();
    workspaceAuth.jobs["sandbox-operations-vitest"].env!.DOCKER_CONFIG =
      "${{ github.workspace }}/docker";
    expect(validateSandboxOperationsWorkflow(workspaceAuth)).toContain(
      "sandbox-operations-vitest must not configure Docker auth at job scope",
    );

    const unsanitizedInstall = readSandboxOperationsWorkflow();
    unsanitizedInstall.jobs["sandbox-operations-vitest"].steps!.find(
      (step) => step.name === "Install OpenShell CLI",
    )!.run = "bash scripts/install-openshell.sh";
    expect(validateSandboxOperationsWorkflow(unsanitizedInstall)).toContain(
      "sandbox-operations-vitest step 'Install OpenShell CLI' must run: -u DOCKER_CONFIG",
    );

    const broadInferenceSecret = readSandboxOperationsWorkflow();
    broadInferenceSecret.jobs["sandbox-operations-vitest"].steps!.find(
      (step) => step.name === "Build CLI",
    )!.env = { NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}" };
    expect(validateSandboxOperationsWorkflow(broadInferenceSecret)).toContain(
      "sandbox-operations-vitest exposes the inference key outside the live test step",
    );
  });
});
