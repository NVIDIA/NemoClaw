// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  validateE2eWorkflowBoundary,
  validateJetsonRunnerDispatchBoundary,
} from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract.ts";

function validateWorkflowMutation(
  mutate: (workflow: ReturnType<typeof readWorkflow>) => void,
): string[] {
  const workflow = readWorkflow();
  mutate(workflow);
  return validateJetsonRunnerDispatchBoundary(workflow);
}

describe("Jetson nvmap GPU E2E workflow boundary", () => {
  it("rejects a permissive Jetson runner opt-in", () => {
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
        "workflow_dispatch allow_jetson_runner_queue input must require repository administrator confirmation from the authoritative NVIDIA/NemoClaw Settings -> Actions -> Runners inventory and document queued timeout behavior",
      ]),
    );

    const guardErrors = validateWorkflowMutation((workflow) => {
      const job = (workflow.jobs as Record<string, unknown>)["jetson-nvmap-gpu"] as {
        "runs-on"?: string;
        if?: string;
        steps?: Array<{ name?: string }>;
      };
      job["runs-on"] = "self-hosted";
      job.if = "${{ true }}";
      job.steps!.push({ name: "Guard Jetson runner dispatch" });
    });
    expect(guardErrors).toEqual(
      expect.arrayContaining([
        "jetson-nvmap-gpu job must require allow_jetson_runner_queue before runner assignment and retain trusted-main selectors",
        "jetson-nvmap-gpu job must use the configured runner only after job-level opt-in",
        "jetson-nvmap-gpu must enforce opt-in before runner assignment, not in a step",
      ]),
    );
  });

  it("requires the Jetson flag at the job boundary", () => {
    const errors = validateWorkflowMutation((workflow) => {
      const job = (workflow.jobs as Record<string, unknown>)["jetson-nvmap-gpu"] as {
        if?: string;
      };
      job.if = job.if?.replace("inputs.allow_jetson_runner_queue && ", "");
    });

    expect(errors).toContain(
      "jetson-nvmap-gpu job must require allow_jetson_runner_queue before runner assignment and retain trusted-main selectors",
    );
  });

  it("accepts the real workflow without Jetson queue contract errors", () => {
    const errors = validateE2eWorkflowBoundary();
    expect(errors.filter((error) => /jetson|allow_jetson_runner_queue/iu.test(error))).toEqual([]);
    expect(errors).toEqual([]);
  });
});
