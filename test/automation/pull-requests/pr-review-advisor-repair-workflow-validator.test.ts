// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  validateGeneratedHeadWorkflow,
  validatePhase1WorkflowAuthority,
  validateReconciliationWorkflowAuthority,
} from "../../../scripts/checks/pr-review-advisor-repair-workflow-boundary.mts";
import {
  GENERATED_HEAD_VALIDATIONS,
  GENERATED_HEAD_WORKFLOW_NAMES,
} from "../../../tools/pr-review-advisor-repair/generated-head-validation.mts";

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
    on: {
      workflow_dispatch: {
        inputs: {
          advisor_run_id: {},
          finding_ids_json: {},
          pr_number: {},
          repository_egress_authorized: {},
          source_head_sha: {},
        },
      },
    },
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

function generatedHeadWorkflow(consumerNeeds?: string): Record<string, unknown> {
  const trustedCheckout = {
    uses: `actions/checkout@${"a".repeat(40)}`,
    with: {
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
    },
  };
  return {
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
        steps: [
          trustedCheckout,
          {
            env: {
              BASE_SHA: "${{ inputs.base_sha }}",
              GITHUB_WORKFLOW_SHA: "${{ github.workflow_sha }}",
              PR_NUMBER: "${{ inputs.pr_number }}",
              REPAIR_ATTEMPT_KEY: "${{ inputs.repair_attempt_key }}",
              SOURCE_HEAD_SHA: "${{ inputs.source_head_sha }}",
            },
            run: "node tools/pr-review-advisor-repair/generated-head-context.mts",
          },
        ],
      },
      consumer: {
        ...(consumerNeeds ? { needs: consumerNeeds } : {}),
        steps: [
          {
            uses: `actions/checkout@${"b".repeat(40)}`,
            with: { ref: "${{ inputs.source_head_sha }}" },
          },
        ],
      },
    },
  };
}

describe("PR Review Advisor repair workflow validator", () => {
  it("derives the workflow boundary inventory from generated-head validation (#10791)", () => {
    expect(GENERATED_HEAD_WORKFLOW_NAMES).toEqual(
      GENERATED_HEAD_VALIDATIONS.map(({ workflow }) => workflow),
    );
    expect(new Set(GENERATED_HEAD_WORKFLOW_NAMES).size).toBe(GENERATED_HEAD_VALIDATIONS.length);
  });

  it("rejects model credentials combined with publication authority (#10791)", () => {
    const workflow = phase1Workflow();
    const publish = workflow.jobs as Record<string, Record<string, unknown>>;
    publish.publish!.env = { OPENAI_API_KEY: "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}" };

    expect(validatePhase1WorkflowAuthority(workflow)).toContain(
      "only the read-only repair job may receive the model credential",
    );
  });

  it("rejects dispatcher-controlled product-scope authority (#10791)", () => {
    const workflow = phase1Workflow();
    const dispatch = (workflow.on as Record<string, Record<string, unknown>>).workflow_dispatch!;
    (dispatch.inputs as Record<string, unknown>).product_scope_identity = {};

    expect(validatePhase1WorkflowAuthority(workflow)).toContain(
      "Phase 1 workflow must expose only its reviewed dispatch inputs",
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

  it("rejects generated-head consumers that bypass the trusted verifier (#10791)", () => {
    expect(validateGeneratedHeadWorkflow("synthetic.yaml", generatedHeadWorkflow())).toContain(
      "synthetic.yaml generated-head consumers must depend on its trusted verifier: consumer",
    );
  });

  it("accepts generated-head consumers gated by the trusted verifier (#10791)", () => {
    expect(
      validateGeneratedHeadWorkflow("synthetic.yaml", generatedHeadWorkflow("verify")),
    ).toEqual([]);
  });
});
