// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  evaluateE2eWorkflowDispatchSelectors,
  formatFreeStandingJobsInventoryForShell,
  readFreeStandingJobsInventory,
  validateE2eWorkflowBoundary,
  validateFreeStandingWorkflowInventory,
} from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract.ts";

function workflowDispatchInputs(): Record<
  string,
  { default?: unknown; description?: string; type?: string }
> {
  const workflow = readWorkflow();
  const triggers = (workflow.on ?? workflow[true as unknown as string]) as {
    workflow_dispatch?: {
      inputs?: Record<string, { default?: unknown; description?: string; type?: string }>;
    };
  };
  return triggers.workflow_dispatch?.inputs ?? {};
}

function validateWorkflowMutation(
  mutate: (workflow: ReturnType<typeof readWorkflow>) => void,
): string[] {
  const workflow = readWorkflow();
  mutate(workflow);
  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-jetson-guard-"));
  const workflowPath = join(directory, "workflow.yaml");
  try {
    writeFileSync(workflowPath, YAML.stringify(workflow));
    return validateE2eWorkflowBoundary(workflowPath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("Jetson nvmap GPU E2E workflow boundary", () => {
  it("keeps Jetson selectable but excluded from full-suite dispatch", () => {
    const inventory = readFreeStandingJobsInventory();
    expect(validateE2eWorkflowBoundary()).toEqual([]);
    expect(inventory.allowedJobs).toContain("jetson-nvmap-gpu");
    expect(inventory.explicitOnlyJobs).toContain("jetson-nvmap-gpu");
    expect(formatFreeStandingJobsInventoryForShell(inventory)).toContain(
      "explicit_only_jobs_csv=openshell-gateway-auth-contract,mcp-bridge-dev,hermes-gpu-startup,sandbox-rlimits-connect,jetson-nvmap-gpu",
    );
    expect(inventory.targetToJob.get("jetson-nvmap-gpu")).toBe("jetson-nvmap-gpu");
    expect(evaluateE2eWorkflowDispatchSelectors({}).selectedFreeStandingJobs).not.toContain(
      "jetson-nvmap-gpu",
    );
  });

  it("rejects invalid explicit-only workflow metadata", () => {
    const workflow = readWorkflow();
    const jobs = workflow.jobs as Record<string, { env?: Record<string, unknown> }>;
    jobs["jetson-nvmap-gpu"].env!.E2E_DEFAULT_ENABLED = "yes";
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-explicit-only-"));
    const workflowPath = join(directory, "workflow.yaml");
    try {
      writeFileSync(workflowPath, YAML.stringify(workflow));
      expect(validateFreeStandingWorkflowInventory(workflowPath)).toContain(
        'jetson-nvmap-gpu job E2E_DEFAULT_ENABLED must be "0" when set',
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("runs Jetson only when explicitly selected", () => {
    for (const selector of [{ targets: "jetson-nvmap-gpu" }, { jobs: "jetson-nvmap-gpu" }]) {
      expect(evaluateE2eWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["jetson-nvmap-gpu"],
        registryTargets: [],
      });
    }
  });

  it("fails explicit Jetson dispatch on hosted runners unless runner queueing is confirmed (#6430)", () => {
    const workflow = readWorkflow();
    const job = (workflow.jobs as Record<string, unknown>)["jetson-nvmap-gpu"] as {
      "runs-on"?: string;
      steps?: Array<{
        env?: Record<string, string>;
        if?: string;
        name?: string;
        run?: string;
        uses?: string;
      }>;
    };
    const inputs = workflowDispatchInputs();
    const guard = job.steps?.find((step) => step.name === "Guard Jetson runner dispatch");
    const checkoutIndex =
      job.steps?.findIndex((step) => String(step.uses ?? "").startsWith("actions/checkout@")) ?? -1;
    const guardIndex =
      job.steps?.findIndex((step) => step.name === "Guard Jetson runner dispatch") ?? -1;
    const dockerAuthIndex =
      job.steps?.findIndex((step) => step.name === "Authenticate to Docker Hub") ?? -1;
    const upload = job.steps?.find((step) => step.name === "Upload Jetson nvmap GPU artifacts");
    const cleanup = job.steps?.find((step) => step.name === "Clean up Docker auth");

    expect(inputs.allow_jetson_runner_queue).toMatchObject({
      default: false,
      type: "boolean",
    });
    expect(inputs.allow_jetson_runner_queue?.description).toContain("Repository administrators");
    expect(inputs.allow_jetson_runner_queue?.description).toContain("authoritative");
    expect(inputs.allow_jetson_runner_queue?.description).toContain(
      "NVIDIA/NemoClaw Settings -> Actions -> Runners",
    );
    expect(inputs.allow_jetson_runner_queue?.description).toContain("timeout-minutes");
    expect(job["runs-on"]).toBe(
      "${{ inputs.allow_jetson_runner_queue && (vars.JETSON_E2E_RUNNER_LABEL || 'linux-arm64-gpu-jetson-orin-latest-1') || 'ubuntu-latest' }}",
    );
    expect(guard?.if).toBe("${{ !inputs.allow_jetson_runner_queue }}");
    expect(guard?.env?.JETSON_E2E_RUNNER_LABEL).toBe(
      "${{ vars.JETSON_E2E_RUNNER_LABEL || 'linux-arm64-gpu-jetson-orin-latest-1' }}",
    );
    expect(guard?.run).toContain("allow_jetson_runner_queue=true");
    expect(guard?.run).toContain("timeout-minutes");
    expect(guard?.run).toContain("repository administrator");
    expect(guard?.run).toContain("authoritative");
    expect(guard?.run).toContain("NVIDIA/NemoClaw Settings -> Actions -> Runners");
    expect(guard?.run).toContain("${JETSON_E2E_RUNNER_LABEL}");
    expect(guard?.run).not.toContain("linux-arm64-gpu-jetson-orin-latest-1");
    expect(checkoutIndex).toBeLessThan(guardIndex);
    expect(guardIndex).toBeLessThan(dockerAuthIndex);
    expect(upload?.if).toBe("always()");
    expect(cleanup?.if).toBe("always()");
  });

  it("rejects a Jetson guard that only prints the fallback runner label (#6430)", () => {
    const errors = validateWorkflowMutation((workflow) => {
      const job = (workflow.jobs as Record<string, unknown>)["jetson-nvmap-gpu"] as {
        steps?: Array<{
          env?: Record<string, string>;
          name?: string;
          run?: string;
        }>;
      };
      const guard = job.steps?.find((step) => step.name === "Guard Jetson runner dispatch");
      expect(guard).toBeDefined();
      guard!.env = {
        JETSON_E2E_RUNNER_LABEL: "linux-arm64-gpu-jetson-orin-latest-1",
      };
      guard!.run = guard!.run?.replace(
        "${JETSON_E2E_RUNNER_LABEL}",
        "linux-arm64-gpu-jetson-orin-latest-1",
      );
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "jetson-nvmap-gpu dispatch guard must receive the configured Jetson runner label",
        "step 'Guard Jetson runner dispatch' run script must include ${JETSON_E2E_RUNNER_LABEL}",
        "step 'Guard Jetson runner dispatch' run script must not include linux-arm64-gpu-jetson-orin-latest-1",
      ]),
    );
  });

  it("accepts the real workflow without Jetson queue contract errors (#6430)", () => {
    const errors = validateE2eWorkflowBoundary();
    expect(errors.filter((error) => /jetson|allow_jetson_runner_queue/iu.test(error))).toEqual([]);
    expect(errors).toEqual([]);
  });
});
