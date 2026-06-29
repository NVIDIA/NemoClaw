// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  readInferenceSwitchWorkflow,
  validateInferenceSwitchWorkflow,
  validateInferenceSwitchWorkflowBoundary,
} from "../../../tools/e2e-scenarios/inference-switch-workflow-boundary.mts";
import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  validateE2eVitestScenariosWorkflowBoundary,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

describe("inference switch workflow boundary", () => {
  it("runs hosted and Anthropic-compatible modes for both agents", () => {
    expect(validateInferenceSwitchWorkflowBoundary()).toEqual([]);
    expect(validateE2eVitestScenariosWorkflowBoundary()).toEqual([]);

    for (const [job, scenario] of [
      ["hermes-inference-switch-vitest", "hermes-inference-switch"],
      ["openclaw-inference-switch-vitest", "openclaw-inference-switch"],
    ]) {
      expect(evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: scenario })).toMatchObject({
        valid: true,
        liveScenariosRuns: false,
        selectedFreeStandingJobs: [job],
      });
      expect(evaluateE2eVitestWorkflowDispatchSelectors({ jobs: job })).toMatchObject({
        valid: true,
        liveScenariosRuns: false,
        selectedFreeStandingJobs: [job],
      });
    }
  });

  it("rejects removal or misconfiguration of an Anthropic-compatible mode", () => {
    const missingMode = readInferenceSwitchWorkflow();
    missingMode.jobs["hermes-inference-switch-vitest"].strategy?.matrix?.include?.pop();
    expect(validateInferenceSwitchWorkflow(missingMode)).toContain(
      "hermes-inference-switch-vitest must run the exact hosted and Anthropic-compatible modes",
    );

    const failFast = readInferenceSwitchWorkflow();
    failFast.jobs["hermes-inference-switch-vitest"].strategy!["fail-fast"] = true;
    expect(validateInferenceSwitchWorkflow(failFast)).toContain(
      "hermes-inference-switch-vitest mode matrix must not fail fast",
    );

    const hardcodedMode = readInferenceSwitchWorkflow();
    hardcodedMode.jobs["openclaw-inference-switch-vitest"].env!.NEMOCLAW_SWITCH_PROVIDER =
      "compatible-endpoint";
    expect(validateInferenceSwitchWorkflow(hardcodedMode)).toContain(
      "openclaw-inference-switch-vitest must map NEMOCLAW_SWITCH_PROVIDER from its mode matrix",
    );

    const broadPermissions = readInferenceSwitchWorkflow();
    broadPermissions.jobs["openclaw-inference-switch-vitest"].permissions!.contents = "write";
    expect(validateInferenceSwitchWorkflow(broadPermissions)).toContain(
      "openclaw-inference-switch-vitest must pin contents permission to read",
    );

    const lingeringCredentials = readInferenceSwitchWorkflow();
    const steps = lingeringCredentials.jobs["openclaw-inference-switch-vitest"].steps!;
    const cleanupIndex = steps.findIndex((step) => step.name === "Clean up Docker auth");
    const uploadIndex = steps.findIndex(
      (step) => step.name === "Upload OpenClaw inference switch artifacts",
    );
    [steps[cleanupIndex], steps[uploadIndex]] = [steps[uploadIndex], steps[cleanupIndex]];
    expect(validateInferenceSwitchWorkflow(lingeringCredentials)).toContain(
      "openclaw-inference-switch-vitest must build, authenticate, test, clean credentials, then upload",
    );
  });

  it("keeps the mode ratchet in the central workflow check", () => {
    const workflow = readInferenceSwitchWorkflow();
    workflow.jobs["openclaw-inference-switch-vitest"].strategy?.matrix?.include?.pop();
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-inference-switch-workflow-"));
    const workflowPath = join(directory, "workflow.yaml");
    try {
      writeFileSync(workflowPath, YAML.stringify(workflow));
      expect(validateE2eVitestScenariosWorkflowBoundary(workflowPath)).toContain(
        "openclaw-inference-switch-vitest must run the exact hosted and Anthropic-compatible modes",
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
