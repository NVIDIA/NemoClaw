// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { discoverExecutionProfileTests } from "../../../tools/e2e/execution-profile.mts";
import {
  evaluateE2eWorkflowDispatchSelectors,
  validateE2eWorkflowBoundary,
} from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type Workflow = {
  jobs: Record<
    string,
    {
      env?: Record<string, unknown>;
      needs?: string[];
      steps?: Array<{ name?: string; run?: string }>;
    }
  >;
};

function validateMutatedWorkflow(mutator: (workflow: Workflow) => void): string[] {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermetic-workflow-"));
  const workflowPath = path.join(directory, "workflow.yaml");
  const workflow = readWorkflow() as Workflow;
  try {
    mutator(workflow);
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));
    return validateE2eWorkflowBoundary(workflowPath);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

describe("hermetic E2E workflow boundary", () => {
  it("keeps discovered tests default-enabled and selectively dispatchable", () => {
    expect(validateE2eWorkflowBoundary()).toEqual([]);

    for (const { id } of discoverExecutionProfileTests()) {
      for (const selector of [{ targets: id }, { jobs: id }]) {
        expect(evaluateE2eWorkflowDispatchSelectors(selector)).toMatchObject({
          valid: true,
          liveTargetsRun: false,
          selectedFreeStandingJobs: [id],
        });
      }
      expect(evaluateE2eWorkflowDispatchSelectors({}).selectedFreeStandingJobs).toContain(id);
    }
  });

  it("ratchets profile setup, generic execution, and aggregation", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const job = workflow.jobs.hermetic;
      job.env!.CHECK_DOC_LINKS_REMOTE = "1";
      job.steps!.find((step) => step.name === "Run discovered hermetic test")!.run = "echo skipped";
      workflow.jobs["report-to-pr"].needs = workflow.jobs["report-to-pr"].needs!.filter(
        (name) => name !== "hermetic",
      );
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "hermetic job must set CHECK_DOC_LINKS_REMOTE to 0",
        'step \'Run discovered hermetic test\' run script must include npx vitest run --project "${TEST_PROJECT}" "${TEST_FILE}"',
        "report-to-pr job must wait for hermetic",
      ]),
    );
  });

  it("reports a missing executor as a contract error", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      delete workflow.jobs.hermetic;
    });

    expect(errors).toContain("workflow missing hermetic execution job");
  });
});
