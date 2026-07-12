// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract.ts";

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
  it("rejects unsafe runner opt-in, routing, and guard ordering drift (#6430)", () => {
    const inputErrors = validateWorkflowMutation((workflow) => {
      const triggers = (workflow.on ?? workflow[true as unknown as string]) as {
        workflow_dispatch?: {
          inputs?: Record<string, { default?: unknown; description?: string; type?: string }>;
        };
      };
      const input = triggers.workflow_dispatch!.inputs!.allow_jetson_runner_queue;
      input.type = "string";
      input.default = true;
      input.description = "Queue the runner";
    });
    expect(inputErrors).toEqual(
      expect.arrayContaining([
        "workflow_dispatch allow_jetson_runner_queue input must be boolean",
        "workflow_dispatch allow_jetson_runner_queue input must default to false",
        "workflow_dispatch allow_jetson_runner_queue input must identify repository administrators and NVIDIA/NemoClaw Settings -> Actions -> Runners as the authoritative runner inventory, and document queued timeout behavior",
      ]),
    );

    const guardErrors = validateWorkflowMutation((workflow) => {
      const job = (workflow.jobs as Record<string, unknown>)["jetson-nvmap-gpu"] as {
        "runs-on"?: string;
        steps?: Array<{ if?: string; name?: string; uses?: string }>;
      };
      job["runs-on"] = "self-hosted";
      const steps = job.steps!;
      const guardIndex = steps.findIndex((step) => step.name === "Guard Jetson runner dispatch");
      const [guard] = steps.splice(guardIndex, 1);
      guard!.if = "always()";
      const authIndex = steps.findIndex((step) => step.name === "Authenticate to Docker Hub");
      steps.splice(authIndex + 1, 0, guard!);
      steps.find((step) => step.name === "Upload Jetson nvmap GPU artifacts")!.if = "success()";
      steps.find((step) => step.name === "Clean up Docker auth")!.if = "success()";
    });
    expect(guardErrors).toEqual(
      expect.arrayContaining([
        "jetson-nvmap-gpu job must use ubuntu-latest unless allow_jetson_runner_queue is true",
        "jetson-nvmap-gpu dispatch guard must run before Docker Hub auth",
        "jetson-nvmap-gpu dispatch guard must run unless allow_jetson_runner_queue is true",
        "jetson-nvmap-gpu upload-e2e-artifacts invocation must run with always()",
        "jetson-nvmap-gpu Docker Hub cleanup step must always run",
      ]),
    );
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
