// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob } from "./helpers/e2e-workflow-contract";

type ApprovalWorkflow = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  on?: {
    pull_request_target?: {
      types?: string[];
    };
  };
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

const WORKFLOW_PATH = ".github/workflows/approve-maintainer-pr-workflow-runs.yaml";
const HELPER_PATH = "tools/ci/approve-maintainer-pr-workflow-runs.mts";
const TRUSTED_CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const GITHUB_SCRIPT_ACTION = "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3";

function workflowFixture(): ApprovalWorkflow {
  return structuredClone(readYaml<ApprovalWorkflow>(WORKFLOW_PATH));
}

function requireStep(job: WorkflowJob, name: string) {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `workflow must contain ${name}`).toBeDefined();
  return step!;
}

function trustedBootstrapErrors(workflow: ApprovalWorkflow): string[] {
  const errors: string[] = [];
  const job = workflow.jobs.approve;
  if (!job) return ["workflow is missing approve job"];

  if (
    JSON.stringify(workflow.on?.pull_request_target) !==
    JSON.stringify({
      types: ["opened", "synchronize", "reopened", "edited", "ready_for_review"],
    })
  ) {
    errors.push("workflow must keep the pull_request_target event contract");
  }
  if (
    JSON.stringify(workflow.permissions) !==
    JSON.stringify({ actions: "write", contents: "read", "pull-requests": "read" })
  ) {
    errors.push("workflow must keep its least-privilege permission contract");
  }
  if (
    JSON.stringify(workflow.concurrency) !==
    JSON.stringify({
      group:
        "approve-maintainer-pr-workflow-runs-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}",
      "cancel-in-progress": false,
    })
  ) {
    errors.push("workflow must keep exact-head non-cancelling concurrency");
  }
  if (job.if !== "${{ github.repository == 'NVIDIA/NemoClaw' }}" || job["timeout-minutes"] !== 2) {
    errors.push("approve job must stay repository-bound and time-bounded");
  }

  const steps = job.steps ?? [];
  if (
    JSON.stringify(steps.map((step) => step.name)) !==
    JSON.stringify([
      "Validate trusted helper revision",
      "Check out trusted approval helper",
      "Verify trusted approval helper",
      "Approve exact-head maintainer workflow runs",
    ])
  ) {
    errors.push("approve job must keep the trusted bootstrap step order");
  }

  const validate = steps[0];
  if (
    (validate as { shell?: string } | undefined)?.shell !== "bash" ||
    validate.env?.TRUSTED_HELPER_SHA !== "${{ github.event.pull_request.base.sha }}" ||
    !validate.run?.includes('[[ "$TRUSTED_HELPER_SHA" =~ ^[a-f0-9]{40}$ ]]') ||
    !validate.run.includes('[[ ! -e "$TRUSTED_HELPER_ROOT" && ! -L "$TRUSTED_HELPER_ROOT" ]]')
  ) {
    errors.push("workflow must validate the base SHA and unused checkout root before checkout");
  }

  const checkout = steps[1];
  if (
    checkout?.uses !== TRUSTED_CHECKOUT_ACTION ||
    checkout.with?.repository !== "NVIDIA/NemoClaw" ||
    checkout.with?.ref !== "${{ github.event.pull_request.base.sha }}" ||
    checkout.with?.path !== ".trusted-maintainer-approval" ||
    String(checkout.with?.["sparse-checkout"] ?? "").trim() !== HELPER_PATH ||
    checkout.with?.["sparse-checkout-cone-mode"] !== "false" ||
    checkout.with?.["persist-credentials"] !== "false" ||
    checkout.with?.["fetch-depth"] !== "1"
  ) {
    errors.push("workflow must sparse-check out only the helper from the exact PR base SHA");
  }

  const verify = steps[2];
  if (
    (verify as { shell?: string } | undefined)?.shell !== "bash" ||
    verify.env?.TRUSTED_HELPER_SHA !== "${{ github.event.pull_request.base.sha }}" ||
    verify.env?.TRUSTED_HELPER_RELATIVE_PATH !== HELPER_PATH ||
    !verify.run?.includes('git -C "$TRUSTED_HELPER_ROOT" rev-parse --verify HEAD') ||
    !verify.run.includes('[[ -f "$helper" && ! -L "$helper" ]]')
  ) {
    errors.push("workflow must verify helper provenance and file type before execution");
  }

  const execute = steps[3];
  const script = String(execute?.with?.script ?? "");
  if (
    execute?.uses !== GITHUB_SCRIPT_ACTION ||
    execute.env?.TRUSTED_HELPER_SHA !== "${{ github.event.pull_request.base.sha }}" ||
    execute.env?.TRUSTED_HELPER_PATH !==
      "${{ github.workspace }}/.trusted-maintainer-approval/tools/ci/approve-maintainer-pr-workflow-runs.mts" ||
    !script.includes("pathToFileURL(helperPath)") ||
    !script.includes("approveMaintainerPrWorkflowRuns") ||
    !script.includes("{ github, context, core }") ||
    script.includes("github.rest.") ||
    script.includes("pull_request.head.sha")
  ) {
    errors.push(
      "workflow must invoke only the trusted helper through the pinned GitHub Script action",
    );
  }

  return errors;
}

describe("maintainer PR workflow-run approval", () => {
  // source-shape-contract: security -- The actions:write pull_request_target workflow must load only the directly tested helper from its exact trusted base SHA
  it("keeps workflow approval inside the trusted metadata boundary", () => {
    const workflow = readYaml<ApprovalWorkflow>(WORKFLOW_PATH);
    expect(trustedBootstrapErrors(workflow)).toEqual([]);

    const untrustedHead = workflowFixture();
    requireStep(untrustedHead.jobs.approve!, "Check out trusted approval helper").with!.ref =
      "${{ github.event.pull_request.head.sha }}";
    expect(trustedBootstrapErrors(untrustedHead)).toContain(
      "workflow must sparse-check out only the helper from the exact PR base SHA",
    );

    const broadCheckout = workflowFixture();
    requireStep(broadCheckout.jobs.approve!, "Check out trusted approval helper").with![
      "sparse-checkout"
    ] = "tools";
    expect(trustedBootstrapErrors(broadCheckout)).toContain(
      "workflow must sparse-check out only the helper from the exact PR base SHA",
    );

    const inlineApi = workflowFixture();
    requireStep(inlineApi.jobs.approve!, "Approve exact-head maintainer workflow runs")
      .with!.script = "await github.rest.actions.approveWorkflowRun({ run_id: 1 });";
    expect(trustedBootstrapErrors(inlineApi)).toContain(
      "workflow must invoke only the trusted helper through the pinned GitHub Script action",
    );
  });
});
