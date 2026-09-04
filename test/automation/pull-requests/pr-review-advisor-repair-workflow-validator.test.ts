// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  validateGeneratedHeadWorkflow,
  validatePhase1WorkflowAuthority,
  validateReconciliationWorkflowAuthority,
} from "../../../scripts/checks/pr-review-advisor-repair-workflow-boundary.mts";

const checkout = {
  uses: `actions/checkout@${"a".repeat(40)}`,
  with: {
    repository: "NVIDIA/NemoClaw",
    ref: "${{ github.workflow_sha }}",
    path: "trusted",
    "persist-credentials": false,
    lfs: false,
    submodules: false,
  },
};

function job(
  permissions: Record<string, string>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { permissions, steps: [structuredClone(checkout)], ...extra };
}

function phase1Workflow(): Record<string, unknown> {
  const exactHeadCheckout = {
    uses: `actions/checkout@${"b".repeat(40)}`,
    with: {
      repository: "NVIDIA/NemoClaw",
      ref: "${{ needs.collect.outputs.source_head_sha }}",
      path: "source",
      "persist-credentials": false,
    },
  };
  return {
    on: { workflow_dispatch: {} },
    permissions: {},
    jobs: {
      collect: job({ actions: "read", checks: "write", contents: "read", "pull-requests": "read" }),
      repair: job(
        { actions: "read", contents: "read" },
        {
          if: "${{ github.run_attempt == 1 }}",
          steps: [
            structuredClone(checkout),
            structuredClone(exactHeadCheckout),
            {
              env: {
                OPENAI_API_KEY: "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}",
                REPAIR_COMMAND: "lifecycle",
              },
              run: 'node "$TRUSTED_CHECKOUT/tools/pr-review-advisor-repair/resolve.mts"',
            },
          ],
        },
      ),
      validate: job(
        { actions: "read", contents: "read", "pull-requests": "read" },
        { steps: [structuredClone(checkout), structuredClone(exactHeadCheckout)] },
      ),
      publish: job(
        { actions: "write", checks: "write", contents: "write", "pull-requests": "read" },
        {
          environment: "advisor-repair-publication",
          steps: [structuredClone(checkout), structuredClone(exactHeadCheckout)],
        },
      ),
      "verify-generated-head": job({ actions: "read", checks: "write", contents: "read" }),
    },
  };
}

function reconciliationWorkflow(): Record<string, unknown> {
  return {
    on: { workflow_dispatch: {} },
    permissions: {},
    jobs: {
      collect: job({ actions: "read", contents: "read" }),
      publish: job(
        { actions: "write", checks: "write", contents: "write", "pull-requests": "read" },
        {
          environment: "advisor-repair-publication",
          steps: [
            structuredClone(checkout),
            {
              uses: `actions/checkout@${"b".repeat(40)}`,
              with: {
                repository: "NVIDIA/NemoClaw",
                ref: "${{ inputs.source_head_sha }}",
                path: "source",
                "persist-credentials": false,
              },
            },
          ],
        },
      ),
      "verify-generated-head": job({ actions: "read", checks: "write", contents: "read" }),
    },
  };
}

describe("PR Review Advisor repair workflow validator", () => {
  it("rejects model credentials combined with publication authority (#10791)", () => {
    const workflow = phase1Workflow();
    const publish = workflow.jobs as Record<string, Record<string, unknown>>;
    publish.publish!.env = { OPENAI_API_KEY: "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}" };

    expect(validatePhase1WorkflowAuthority(workflow)).toContain(
      "only the read-only repair job may receive the model credential",
    );
  });

  it("rejects mutable artifact names and PR execution in the repair job (#10791)", () => {
    const workflow = phase1Workflow();
    const repair = (workflow.jobs as Record<string, Record<string, unknown>>).repair!;
    (repair.steps as Array<Record<string, unknown>>).push({
      uses: `actions/download-artifact@${"c".repeat(40)}`,
      with: { name: "mutable" },
    });
    (repair.steps as Array<Record<string, unknown>>).push({ run: "$SOURCE_CHECKOUT/script.sh" });

    expect(validatePhase1WorkflowAuthority(workflow)).toEqual(
      expect.arrayContaining([
        "Phase 1 workflow artifact downloads must use immutable artifact IDs",
        "repair may send source data only through the trusted bounded lifecycle",
      ]),
    );
  });

  it("rejects a second model repair in deterministic reconciliation (#10791)", () => {
    const workflow = reconciliationWorkflow();
    const collect = (workflow.jobs as Record<string, Record<string, unknown>>).collect!;
    collect.env = { OPENAI_API_KEY: "unexpected" };

    expect(validateReconciliationWorkflowAuthority(workflow)).toContain(
      "reconciliation must not invoke a model repair",
    );
  });

  it("rejects a repair job that can run Pi on a workflow rerun (#10791)", () => {
    const workflow = phase1Workflow();
    const repair = (workflow.jobs as Record<string, Record<string, unknown>>).repair!;
    repair.if = "${{ needs.collect.result == 'success' }}";

    expect(validatePhase1WorkflowAuthority(workflow)).toContain(
      "repair must be disabled on workflow reruns",
    );
  });

  it("rejects generated-head workflows that omit exact identity verification (#10791)", () => {
    const workflow = {
      on: {
        workflow_dispatch: {
          inputs: {
            base_sha: {},
            pr_number: {},
            repair_attempt_key: {},
            source_head_sha: {},
          },
        },
      },
      jobs: {
        verify: {
          steps: [structuredClone(checkout), { run: "echo unchecked" }],
        },
      },
    };

    expect(validateGeneratedHeadWorkflow("synthetic.yaml", workflow)).toContain(
      "synthetic.yaml must invoke the exact-identity verifier from trusted workflow code",
    );
  });
});
