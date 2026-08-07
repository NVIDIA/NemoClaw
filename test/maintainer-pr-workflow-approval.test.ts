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

function requireStep(job: WorkflowJob, name: string) {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `workflow must contain ${name}`).toBeDefined();
  return step!;
}

describe("maintainer PR workflow-run approval", () => {
  // source-shape-contract: security -- The actions:write pull_request_target workflow must load only the directly tested helper from its exact trusted base SHA
  it("keeps workflow approval inside the trusted metadata boundary", () => {
    const workflow = readYaml<ApprovalWorkflow>(WORKFLOW_PATH);
    const job = workflow.jobs.approve!;

    expect(workflow.on?.pull_request_target).toEqual({
      types: ["opened", "synchronize", "reopened", "edited", "ready_for_review"],
    });
    expect(workflow.permissions).toEqual({
      actions: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(workflow.concurrency).toEqual({
      group:
        "approve-maintainer-pr-workflow-runs-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}",
      "cancel-in-progress": false,
    });
    expect(job.if).toBe("${{ github.repository == 'NVIDIA/NemoClaw' }}");
    expect(job["timeout-minutes"]).toBe(2);
    expect(job.steps?.map((step) => step.name)).toEqual([
      "Validate trusted helper revision",
      "Check out trusted approval helper",
      "Verify trusted approval helper",
      "Approve exact-head maintainer workflow runs",
    ]);

    const validate = requireStep(job, "Validate trusted helper revision");
    expect((validate as { shell?: string }).shell).toBe("bash");
    expect(validate.env).toEqual({
      TRUSTED_HELPER_ROOT: "${{ github.workspace }}/.trusted-maintainer-approval",
      TRUSTED_HELPER_SHA: "${{ github.event.pull_request.base.sha }}",
    });
    expect(validate.run).toContain('[[ "$TRUSTED_HELPER_SHA" =~ ^[a-f0-9]{40}$ ]]');
    expect(validate.run).toContain(
      '[[ ! -e "$TRUSTED_HELPER_ROOT" && ! -L "$TRUSTED_HELPER_ROOT" ]]',
    );

    const checkout = requireStep(job, "Check out trusted approval helper");
    expect(checkout.uses).toBe(TRUSTED_CHECKOUT_ACTION);
    expect(checkout.with).toMatchObject({
      repository: "NVIDIA/NemoClaw",
      ref: "${{ github.event.pull_request.base.sha }}",
      path: ".trusted-maintainer-approval",
      "sparse-checkout-cone-mode": "false",
      "persist-credentials": "false",
      "fetch-depth": "1",
    });
    expect(String(checkout.with?.["sparse-checkout"] ?? "").trim()).toBe(HELPER_PATH);
    expect(job.steps?.filter((step) => step.uses?.startsWith("actions/checkout@"))).toEqual([
      checkout,
    ]);

    const verify = requireStep(job, "Verify trusted approval helper");
    expect((verify as { shell?: string }).shell).toBe("bash");
    expect(verify.env).toEqual({
      TRUSTED_HELPER_RELATIVE_PATH: HELPER_PATH,
      TRUSTED_HELPER_ROOT: "${{ github.workspace }}/.trusted-maintainer-approval",
      TRUSTED_HELPER_SHA: "${{ github.event.pull_request.base.sha }}",
    });
    expect(verify.run).toContain('git -C "$TRUSTED_HELPER_ROOT" rev-parse --verify HEAD');
    expect(verify.run).toContain('[[ -f "$helper" && ! -L "$helper" ]]');

    const execute = requireStep(job, "Approve exact-head maintainer workflow runs");
    expect(execute.uses).toBe(GITHUB_SCRIPT_ACTION);
    expect(execute.env).toEqual({
      TRUSTED_HELPER_PATH:
        "${{ github.workspace }}/.trusted-maintainer-approval/tools/ci/approve-maintainer-pr-workflow-runs.mts",
      TRUSTED_HELPER_SHA: "${{ github.event.pull_request.base.sha }}",
    });
    expect(execute.with?.["github-token"]).toBe("${{ github.token }}");
    const script = String(execute.with?.script ?? "");
    expect(script).toContain("pathToFileURL(helperPath)");
    expect(script).toContain("approveMaintainerPrWorkflowRuns");
    expect(script).toContain("{ github, context, core }");
    expect(script).not.toContain("github.rest.");
    expect(script).not.toContain("pull_request.head.sha");
  });
});
