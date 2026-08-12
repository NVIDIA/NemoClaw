// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  validateE2eWorkflowBoundary,
  validateJetsonDispatchBoundary,
} from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract.ts";

function validateWorkflowMutation(
  mutate: (workflow: ReturnType<typeof readWorkflow>) => void,
): string[] {
  const workflow = readWorkflow();
  mutate(workflow);
  return validateJetsonDispatchBoundary(workflow);
}

describe("Jetson nvmap GPU E2E workflow boundary", () => {
  it("rejects a permissive Jetson dispatch opt-in (#8142)", () => {
    const inputErrors = validateWorkflowMutation((workflow) => {
      const triggers = (workflow.on ?? workflow[true as unknown as string]) as {
        workflow_dispatch?: {
          inputs?: Record<string, { default?: unknown; description?: string; type?: string }>;
        };
      };
      const input = triggers.workflow_dispatch!.inputs!.allow_jetson_dispatch;
      input.type = "string";
      input.default = true;
      input.description = "Dispatch the Jetson";
    });
    expect(inputErrors).toEqual(
      expect.arrayContaining([
        "workflow_dispatch allow_jetson_dispatch input must be boolean",
        "workflow_dispatch allow_jetson_dispatch input must default to false",
        "workflow_dispatch allow_jetson_dispatch input must require the operator-owned backend, repository URL variable, and controller documentation",
      ]),
    );
  });

  it("keeps opt-in and trusted selectors before controller assignment (#8142)", () => {
    const errors = validateWorkflowMutation((workflow) => {
      const job = (workflow.jobs as Record<string, unknown>)["jetson-nvmap-gpu"] as {
        if?: string;
      };
      job.if = "${{ true }}";
    });

    expect(errors).toContain(
      "jetson-nvmap-gpu job must require the dispatch opt-in, trusted main workflow dispatch, same-repository candidate, and target selectors",
    );
  });

  it("queues every operator-backend dispatch without cancellation (#8142)", () => {
    const workflow = readWorkflow();
    const job = (workflow.jobs as Record<string, unknown>)["jetson-nvmap-gpu"] as {
      concurrency?: Record<string, unknown>;
    };
    job.concurrency = {
      group: "jetson-${{ github.ref }}",
      queue: 1,
      "cancel-in-progress": true,
    };
    expect(validateJetsonDispatchBoundary(workflow)).toContain(
      "jetson-nvmap-gpu concurrency must queue every operator-backend dispatch without cancellation",
    );
  });

  it("rejects candidate execution or credential-bearing controller steps (#8142)", () => {
    const errors = validateWorkflowMutation((workflow) => {
      const job = (workflow.jobs as Record<string, unknown>)["jetson-nvmap-gpu"] as {
        permissions?: Record<string, string>;
        steps?: Array<{ name?: string; run?: string; with?: Record<string, unknown> }>;
      };
      job.permissions!.contents = "write";
      const checkout = job.steps!.find(
        (step) => step.name === "Check out trusted Jetson controller",
      )!;
      checkout.with!.ref = "${{ inputs.checkout_sha }}";
      const dispatch = job.steps!.find(
        (step) => step.name === "Dispatch exact commit to Jetson through operator backend",
      )!;
      dispatch.run = "bash candidate-script.sh";
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "jetson-nvmap-gpu controller must grant only contents:read and id-token:write",
        "jetson-nvmap-gpu checkout must use the trusted workflow SHA without credentials",
        "jetson-nvmap-gpu controller must dispatch only the exact candidate and configured URL",
      ]),
    );
  });

  it("rejects a direct OpenShell installer step in the Jetson controller (#8142)", () => {
    const errors = validateWorkflowMutation((workflow) => {
      const job = (workflow.jobs as Record<string, unknown>)["jetson-nvmap-gpu"] as {
        steps?: Array<{ name?: string; run?: string }>;
      };
      job.steps!.push({
        name: "Install OpenShell directly",
        run: "bash scripts/install-openshell.sh",
      });
    });

    expect(errors).toContain(
      "jetson-nvmap-gpu controller must contain only checkout, Node setup, dispatch, and upload",
    );
  });

  it("keeps the runner temporary artifact path on the dispatch step (#8142)", () => {
    const errors = validateWorkflowMutation((workflow) => {
      const job = (workflow.jobs as Record<string, unknown>)["jetson-nvmap-gpu"] as {
        env?: Record<string, string>;
        steps?: Array<{ env?: Record<string, string>; name?: string }>;
      };
      job.env = {
        E2E_ARTIFACT_DIR: "${{ runner.temp }}/e2e-artifacts/live/jetson-nvmap-gpu",
      };
      const dispatch = job.steps!.find(
        (step) => step.name === "Dispatch exact commit to Jetson through operator backend",
      )!;
      dispatch.env!.E2E_ARTIFACT_DIR = "${{ github.workspace }}/e2e-artifacts";
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "jetson-nvmap-gpu controller must not define a job-level environment",
        "jetson-nvmap-gpu controller must dispatch only the exact candidate and configured URL",
      ]),
    );
  });

  it("accepts the real workflow without Jetson dispatch errors (#8142)", () => {
    expect(validateJetsonDispatchBoundary(readWorkflow())).toEqual([]);
    expect(validateE2eWorkflowBoundary()).toEqual([]);
  });
});
