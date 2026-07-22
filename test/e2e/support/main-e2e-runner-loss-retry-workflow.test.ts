// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  MAIN_E2E_RETRY_CHECKOUT,
  MAIN_E2E_RETRY_COMMAND,
  MAIN_E2E_RETRY_JOB_IF,
  MAIN_E2E_RETRY_SETUP_NODE,
  validateMainE2eRunnerLossRetryWorkflow,
  validateMainE2eRunnerLossRetryWorkflowBoundary,
} from "../../../tools/e2e/main-e2e-runner-loss-retry-workflow-boundary.mts";

function validWorkflow(): Record<string, unknown> {
  return {
    name: "E2E Main Runner Loss Retry",
    "run-name":
      "E2E main runner-loss retry for run ${{ github.event.workflow_run.id }} attempt ${{ github.event.workflow_run.run_attempt }}",
    on: { workflow_run: { workflows: ["E2E"], types: ["completed"] } },
    permissions: {},
    jobs: {
      "classify-and-retry": {
        if: MAIN_E2E_RETRY_JOB_IF,
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 10,
        permissions: { actions: "write", contents: "read" },
        concurrency: {
          group: "e2e-main-runner-loss-retry-${{ github.event.workflow_run.id }}",
          "cancel-in-progress": false,
        },
        steps: [
          {
            name: "Checkout trusted retry controller",
            uses: MAIN_E2E_RETRY_CHECKOUT,
            with: { ref: "${{ github.workflow_sha }}", "persist-credentials": false },
          },
          {
            name: "Setup Node",
            uses: MAIN_E2E_RETRY_SETUP_NODE,
            with: { "node-version": "22" },
          },
          {
            name: "Classify runner loss and retry failed jobs once",
            env: {
              GITHUB_TOKEN: "${{ github.token }}",
              SUBJECT_RUN_ATTEMPT: "${{ github.event.workflow_run.run_attempt }}",
              SUBJECT_RUN_ID: "${{ github.event.workflow_run.id }}",
            },
            run: MAIN_E2E_RETRY_COMMAND,
          },
        ],
      },
    },
  };
}

function retryJob(workflow: Record<string, unknown>): Record<string, unknown> {
  return (workflow.jobs as Record<string, Record<string, unknown>>)["classify-and-retry"]!;
}

type WorkflowMutation = (workflow: Record<string, unknown>) => void;

const WORKFLOW_MUTATIONS = [
  [
    "a pull-request event",
    (workflow: Record<string, unknown>) => {
      retryJob(workflow).if = MAIN_E2E_RETRY_JOB_IF.replace(
        "github.event.workflow_run.event != 'pull_request'",
        "true",
      );
    },
  ],
  [
    "a selective-dispatch title",
    (workflow: Record<string, unknown>) => {
      retryJob(workflow).if = MAIN_E2E_RETRY_JOB_IF.replace("'E2E main'", "'E2E PR'");
    },
  ],
  [
    "a later run attempt",
    (workflow: Record<string, unknown>) => {
      retryJob(workflow).if = MAIN_E2E_RETRY_JOB_IF.replace("run_attempt == 1", "run_attempt > 0");
    },
  ],
  [
    "workflow-wide write permission",
    (workflow: Record<string, unknown>) => {
      workflow.permissions = { actions: "write" };
    },
  ],
  [
    "a subject-SHA checkout",
    (workflow: Record<string, unknown>) => {
      const steps = retryJob(workflow).steps as Record<string, unknown>[];
      steps[0]!.with = {
        ref: "${{ github.event.workflow_run.head_sha }}",
        "persist-credentials": false,
      };
    },
  ],
  [
    "a repository secret",
    (workflow: Record<string, unknown>) => {
      const steps = retryJob(workflow).steps as Record<string, unknown>[];
      (steps[2]!.env as Record<string, unknown>).EXTRA_TOKEN = "${{ secrets.EXTRA_TOKEN }}";
    },
  ],
  [
    "an unreviewed command",
    (workflow: Record<string, unknown>) => {
      const steps = retryJob(workflow).steps as Record<string, unknown>[];
      steps[2]!.run = "gh run rerun --failed";
    },
  ],
] satisfies ReadonlyArray<readonly [string, WorkflowMutation]>;

describe("final-main E2E runner-loss retry workflow for item 5 (#7140)", () => {
  it("accepts the reviewed trusted workflow", () => {
    expect(validateMainE2eRunnerLossRetryWorkflowBoundary()).toEqual([]);
  });

  it.each(WORKFLOW_MUTATIONS)("rejects %s", (_label, mutate) => {
    const workflow = validWorkflow();
    mutate(workflow);
    expect(validateMainE2eRunnerLossRetryWorkflow(workflow)).not.toEqual([]);
  });
});
