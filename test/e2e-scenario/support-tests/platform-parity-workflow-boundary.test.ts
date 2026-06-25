// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateE2eVitestScenariosWorkflowBoundary,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";
import { canonicalScenarios } from "../scenarios/scenarios/baseline.ts";

function scenarioById(id: string) {
  const scenario = canonicalScenarios().find((entry) => entry.id === id);
  if (!scenario) throw new Error(`missing scenario ${id}`);
  return scenario;
}

describe("P0-E platform parity workflow coverage", () => {
  it("keeps the WSL platform scenario on a Windows WSL runner boundary", () => {
    const wsl = scenarioById("wsl-repo-cloud-openclaw");

    expect(wsl.environment).toMatchObject({
      platform: "wsl-local",
      runtime: "docker-running",
      onboarding: "cloud-openclaw",
    });
    expect(wsl.runnerRequirements).toEqual(expect.arrayContaining(["windows-latest", "wsl2"]));
    expect(wsl.suiteIds).toContain("platform-wsl");
    expect(wsl.requiredSecrets).toContain("NVIDIA_INFERENCE_API_KEY");

    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "wsl-repo-cloud-openclaw" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: true,
      registryScenarios: ["wsl-repo-cloud-openclaw"],
      selectedFreeStandingJobs: [],
    });
  });

  it("keeps GPU, Spark, and Jetson platform selectors explicit and routable", () => {
    expect(validateE2eVitestScenariosWorkflowBoundary()).toEqual([]);

    const inventory = readFreeStandingJobsInventory();
    expect(inventory.scenarioToJob.get("gpu-e2e")).toBe("gpu-e2e-vitest");
    expect(inventory.scenarioToJob.get("gpu-double-onboard")).toBe("gpu-double-onboard-vitest");
    expect(inventory.scenarioToJob.get("spark-install")).toBe("spark-install-vitest");
    expect(inventory.scenarioToJob.get("jetson-nvmap-gpu")).toBe("jetson-nvmap-gpu-vitest");

    expect(evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "gpu-e2e" })).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["gpu-e2e-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "gpu-double-onboard" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["gpu-double-onboard-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "spark-install" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["spark-install-vitest"],
      registryScenarios: [],
    });

    // Jetson/Tegra hardware is still an explicit-only route; do not imply the
    // default full-suite dispatch proved /dev/nvmap group behavior.
    expect(evaluateE2eVitestWorkflowDispatchSelectors({}).selectedFreeStandingJobs).not.toContain(
      "jetson-nvmap-gpu-vitest",
    );
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "jetson-nvmap-gpu" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["jetson-nvmap-gpu-vitest"],
      registryScenarios: [],
    });
  });
});
