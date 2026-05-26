// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadE2eWorkflowContract, reusableNightlyJobs } from "./helpers/e2e-workflow-contract";

describe("E2E reusable workflow contract", () => {
  const { runnerWorkflow, nightlyWorkflow, action } = loadE2eWorkflowContract();

  it("does not persist checkout credentials in the reusable runner", () => {
    const checkoutSteps = runnerWorkflow.jobs.run.steps.filter((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );

    expect(checkoutSteps).toHaveLength(2);
    for (const step of checkoutSteps) {
      expect(step.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("runs only validated test/e2e shell scripts through the composite action", () => {
    const runStep = action.runs.steps.find((step) => step.name === "Run E2E script");

    expect(runStep).toBeDefined();
    expect(runStep?.env?.E2E_SCRIPT).toBe("${{ inputs.script }}");
    expect(runStep?.run).toContain('case "$E2E_SCRIPT" in');
    expect(runStep?.run).toContain("test/e2e/*.sh");
    expect(runStep?.run).toContain('bash "$E2E_SCRIPT"');
    expect(runStep?.run).not.toContain('bash "${{ inputs.script }}"');
  });

  it("passes only named secrets to reusable nightly jobs", () => {
    const reusableJobs = reusableNightlyJobs(nightlyWorkflow);

    expect(reusableJobs.length).toBeGreaterThan(20);
    for (const [name, job] of reusableJobs) {
      expect(job.secrets, name).toEqual({
        NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}",
        BRAVE_API_KEY: "${{ secrets.BRAVE_API_KEY }}",
      });
    }
  });

  it("validates env_json keys before writing GITHUB_ENV", () => {
    const exportStep = runnerWorkflow.jobs.run.steps.find(
      (step) => step.name === "Export script environment",
    );

    expect(exportStep?.run).toContain('name_pattern = re.compile(r"^[A-Z_][A-Z0-9_]*$")');
    expect(exportStep?.run).toContain(
      'reserved_prefixes = ("ACTIONS_", "GITHUB_", "INPUT_", "RUNNER_")',
    );
    expect(exportStep?.run).toContain('reserved_names = {"CI", "HOME", "PATH", "PWD", "SHELL"}');
    expect(exportStep?.run).toContain('delimiter = f"EOF_{secrets.token_hex(16)}"');
  });

  it("keeps env_json valid and aligned with target-ref installs", () => {
    const reusableJobs = reusableNightlyJobs(nightlyWorkflow);

    for (const [name, job] of reusableJobs) {
      const envJson = job.with?.env_json;
      if (envJson === undefined) {
        continue;
      }
      const parsed = JSON.parse(envJson) as Record<string, unknown>;
      expect(Object.keys(parsed).length, name).toBeGreaterThan(0);
      if (parsed.NEMOCLAW_INSTALL_REF !== undefined) {
        expect(parsed.NEMOCLAW_INSTALL_REF, name).toBe("${{ inputs.target_ref || github.ref }}");
      }
      expect(parsed.NEMOCLAW_PUBLIC_INSTALL_REF, name).toBeUndefined();
    }
  });

  it("exports checked-out commit SHAs for reusable public-installer jobs", () => {
    const publicInstallerJob = nightlyWorkflow.jobs["cloud-onboard-e2e"];
    const exportStep = runnerWorkflow.jobs.run.steps.find(
      (step) => step.name === "Export checked-out ref environment",
    );

    expect(publicInstallerJob.with?.checked_out_ref_env).toBe("NEMOCLAW_PUBLIC_INSTALL_REF");
    expect(exportStep?.env?.E2E_CHECKED_OUT_REF_ENV).toBe(
      "${{ inputs.checked_out_ref_env }}",
    );
    expect(exportStep?.run).toContain('[[ ! "$E2E_CHECKED_OUT_REF_ENV" =~ ^[A-Z_][A-Z0-9_]*$ ]]');
    expect(exportStep?.run).toContain('git -C repo rev-parse HEAD');
    expect(exportStep?.run).toContain('>> "$GITHUB_ENV"');
  });

  it("keeps converted jobs dispatchable through the reusable workflow", () => {
    const cloudJob = nightlyWorkflow.jobs["cloud-e2e"];

    expect(cloudJob).toBeDefined();
    expect(cloudJob.uses).toBe("./.github/workflows/e2e-script.yaml");
    expect(cloudJob.with?.script).toBe("test/e2e/test-full-e2e.sh");
    expect(cloudJob.with?.ref).toBe("${{ inputs.target_ref || github.ref }}");
  });
});
