// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  validateE2eWorkflow,
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
  it("passes the selected managed-image publication commit to Jetson dispatch", () => {
    const errors = validateWorkflowMutation((workflow) => {
      const publication = (workflow.jobs as Record<string, unknown>)["base-image-publication"] as {
        outputs?: Record<string, unknown>;
      };
      publication.outputs!.managed_image_revision =
        "${{ steps.publication.outputs.head_sha || inputs.checkout_sha || github.sha }}";
    });

    expect(errors).toContain(
      "base-image-publication must expose the managed-image revision to Jetson dispatch",
    );
  });

  it("waits for the exact managed-image publication before Jetson dispatch", () => {
    const errors = validateWorkflowMutation((workflow) => {
      const job = (workflow.jobs as Record<string, unknown>)["jetson-nvmap-gpu"] as {
        needs?: unknown;
      };
      job.needs = "generate-matrix";
    });

    expect(errors).toContain(
      "jetson-nvmap-gpu job must depend on managed publication and generate-matrix",
    );
  });

  it("keeps manual Jetson dispatch disabled by default (#8142)", () => {
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

  it("rejects a Jetson selector that omits trusted main pushes (#8142)", () => {
    const errors = validateWorkflowMutation((workflow) => {
      const job = (workflow.jobs as Record<string, unknown>)["jetson-nvmap-gpu"] as {
        if?: string;
      };
      job.if =
        "${{ inputs.allow_jetson_dispatch && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && (inputs.checkout_repository == '' || inputs.checkout_repository == github.repository) && ((inputs.jobs == '' && inputs.targets == '') || contains(format(',{0},', inputs.jobs), ',jetson-nvmap-gpu,') || contains(format(',{0},', inputs.targets), ',jetson-nvmap-gpu,')) }}";
    });

    expect(errors).toContain(
      "jetson-nvmap-gpu job must run on trusted main pushes and require opt-in for same-repository manual selections",
    );
  });

  it("rejects an untrusted Jetson event selector (#8142)", () => {
    const errors = validateWorkflowMutation((workflow) => {
      const job = (workflow.jobs as Record<string, unknown>)["jetson-nvmap-gpu"] as {
        if?: string;
      };
      job.if = "${{ true }}";
    });

    expect(errors).toContain(
      "jetson-nvmap-gpu job must run on trusted main pushes and require opt-in for same-repository manual selections",
    );
  });

  it("rejects the unsupported queue key from operator-backend concurrency (#8142)", () => {
    const workflow = readWorkflow();
    const job = (workflow.jobs as Record<string, unknown>)["jetson-nvmap-gpu"] as {
      concurrency?: Record<string, unknown>;
    };
    job.concurrency!.queue = "max";
    expect(validateJetsonDispatchBoundary(workflow)).toContain(
      "jetson-nvmap-gpu concurrency must preserve its operator-backend group without cancellation",
    );
  });

  it.each([
    ["Jetson", "${{ inputs.checkout_sha != '' && !inputs.include_staging_brev_launchable }}"],
    ["Launchable", "${{ inputs.checkout_sha != '' && !inputs.allow_jetson_dispatch }}"],
  ])("rejects concurrency that cancels active %s dispatches", (_dispatch, cancellation) => {
    const workflow = readWorkflow();
    const validationError =
      "workflow concurrency must not cancel an active Jetson or Launchable dispatch";
    expect(validateE2eWorkflow(workflow)).not.toContain(validationError);
    const concurrency = workflow.concurrency as Record<string, unknown>;
    concurrency["cancel-in-progress"] = cancellation;

    expect(validateE2eWorkflow(workflow)).toContain(validationError);
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
        "jetson-nvmap-gpu controller must dispatch the exact candidate, managed-image revision, and configured URL",
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
        "jetson-nvmap-gpu controller must dispatch the exact candidate, managed-image revision, and configured URL",
      ]),
    );
  });

  it("accepts the real workflow without Jetson dispatch errors (#8142)", () => {
    expect(validateJetsonDispatchBoundary(readWorkflow())).toEqual([]);
    expect(validateE2eWorkflowBoundary()).toEqual([]);
  });
});
