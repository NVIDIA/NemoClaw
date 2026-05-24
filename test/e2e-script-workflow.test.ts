// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type WorkflowJob = {
  uses?: string;
  secrets?: Record<string, string>;
  with?: Record<string, string>;
};

type WorkflowStep = {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
};

type NightlyWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

type RunnerWorkflow = {
  jobs: {
    run: {
      steps: WorkflowStep[];
    };
  };
};

type CompositeAction = {
  runs: {
    steps: WorkflowStep[];
  };
};

function readYaml<T>(path: string): T {
  return YAML.parse(readFileSync(join(REPO_ROOT, path), "utf-8")) as T;
}

describe("E2E reusable workflow contract", () => {
  const runnerWorkflow = readYaml<RunnerWorkflow>(".github/workflows/e2e-script.yaml");
  const nightlyWorkflow = readYaml<NightlyWorkflow>(".github/workflows/nightly-e2e.yaml");
  const action = readYaml<CompositeAction>(".github/actions/run-e2e-script/action.yaml");

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

    expect(runStep?.env?.E2E_SCRIPT).toBe("${{ inputs.script }}");
    expect(runStep?.run).toContain('case "$E2E_SCRIPT" in');
    expect(runStep?.run).toContain("test/e2e/*.sh");
    expect(runStep?.run).toContain('bash "$E2E_SCRIPT"');
    expect(runStep?.run).not.toContain('bash "${{ inputs.script }}"');
  });

  it("passes only named secrets to reusable nightly jobs", () => {
    const reusableJobs = Object.entries(nightlyWorkflow.jobs).filter(
      ([, job]) => job.uses === "./.github/workflows/e2e-script.yaml",
    );

    expect(reusableJobs.length).toBeGreaterThan(20);
    for (const [name, job] of reusableJobs) {
      expect(job.secrets, name).toEqual({
        NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}",
        BRAVE_API_KEY: "${{ secrets.BRAVE_API_KEY }}",
      });
    }
  });

  it("keeps env_json valid and aligned with target-ref installs", () => {
    const reusableJobs = Object.entries(nightlyWorkflow.jobs).filter(
      ([, job]) => job.uses === "./.github/workflows/e2e-script.yaml",
    );

    for (const [name, job] of reusableJobs) {
      const envJson = job.with?.env_json;
      if (envJson === undefined) {
        continue;
      }
      const parsed = JSON.parse(envJson) as Record<string, unknown>;
      expect(parsed, name).toEqual(expect.any(Object));
      if (parsed.NEMOCLAW_INSTALL_REF !== undefined) {
        expect(parsed.NEMOCLAW_INSTALL_REF, name).toBe("${{ inputs.target_ref || github.ref }}");
      }
    }
  });

  it("keeps converted jobs dispatchable through the reusable workflow", () => {
    const cloudJob = nightlyWorkflow.jobs["cloud-e2e"];

    expect(cloudJob.uses).toBe("./.github/workflows/e2e-script.yaml");
    expect(cloudJob.with?.script).toBe("test/e2e/test-full-e2e.sh");
    expect(cloudJob.with?.ref).toBe("${{ inputs.target_ref || github.ref }}");
  });
});
