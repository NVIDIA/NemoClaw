// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readSecurityPostureWorkflow,
  validateSecurityPostureWorkflow,
} from "../../../tools/e2e/security-posture-workflow-boundary.mts";
import {
  evaluateE2eWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateE2eWorkflowBoundary,
} from "../../../tools/e2e/workflow-boundary.mts";

const WORKFLOW_PATH = join(process.cwd(), ".github", "workflows", "e2e.yaml");

function validateCentralWorkflowMutation(mutate: (source: string) => string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-security-posture-boundary-"));
  const workflowPath = join(directory, "workflow.yaml");
  try {
    writeFileSync(workflowPath, mutate(readFileSync(WORKFLOW_PATH, "utf8")));
    return validateSecurityPostureWorkflow(readSecurityPostureWorkflow(workflowPath));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("security posture workflow boundary", () => {
  it("runs both agent modes by default and through either selector", () => {
    const inventory = readFreeStandingJobsInventory();
    expect(validateE2eWorkflowBoundary()).toEqual([]);
    expect(inventory.targetToJob.get("security-posture")).toBe("security-posture");

    for (const selector of [{ targets: "security-posture" }, { jobs: "security-posture" }]) {
      expect(evaluateE2eWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["security-posture"],
      });
    }
    expect(evaluateE2eWorkflowDispatchSelectors({}).selectedFreeStandingJobs).toContain(
      "security-posture",
    );
  });

  it("rejects missing agent coverage, mode drift, and broadly scoped credentials", () => {
    const hermesMatrixEntry = [
      "          - agent: hermes",
      "            sandbox_name: e2e-hermes-security-posture",
      "            test_file: test/e2e/live/hermes-e2e.test.ts",
      "",
    ].join("\n");
    expect(
      validateCentralWorkflowMutation((source) => {
        expect(source).toContain(hermesMatrixEntry);
        return source.replace(hermesMatrixEntry, "");
      }),
    ).toContain(
      "security-posture matrix must cover the OpenClaw and Hermes security-posture modes",
    );

    const workflow = readSecurityPostureWorkflow();
    const job = (workflow.jobs as Record<string, Record<string, unknown>>)["security-posture"];
    const env = job.env as Record<string, unknown>;
    delete env.NEMOCLAW_E2E_SECURITY_POSTURE;
    job.permissions = { contents: "write" };
    env.NVIDIA_INFERENCE_API_KEY = "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";
    const install = (job.steps as Array<Record<string, unknown>>).find(
      (step) => step.name === "Install OpenShell CLI",
    );
    expect(install).toBeTruthy();
    install!.run = "bash scripts/install-openshell.sh";
    const errors = validateSecurityPostureWorkflow(workflow);
    expect(errors).toContain("security-posture must set NEMOCLAW_E2E_SECURITY_POSTURE=1");
    expect(errors).toContain("security-posture must hold only contents: read");
    expect(errors).toContain("security-posture must not expose the inference key at job scope");
    expect(errors).toContain(
      "security-posture step 'Install OpenShell CLI' must run: -u DOCKER_CONFIG",
    );
  });
});
