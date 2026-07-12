// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  discoverCredentialFreeTests,
  stripCredentialFreeTestDeclarations,
} from "../../../tools/e2e/credential-free-tests.mts";
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shared-e2e-workflow-"));
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

describe("shared E2E workflow boundary", () => {
  it("keeps every tagged credential-free test visible to Vitest discovery", () => {
    const declaredFiles = fs
      .globSync(["**/*.test.js", "**/*.test.ts"], {
        cwd: process.cwd(),
        exclude: ["**/dist/**", "**/node_modules/**"],
      })
      .filter((file) => {
        const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
        return stripCredentialFreeTestDeclarations(source) !== source;
      })
      .sort();

    expect(
      discoverCredentialFreeTests()
        .map(({ file }) => file)
        .sort(),
    ).toEqual(declaredFiles);
  });

  it("keeps discovered tests default-enabled and selectively dispatchable", () => {
    expect(validateE2eWorkflowBoundary()).toEqual([]);

    for (const { id } of discoverCredentialFreeTests()) {
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

  it("ratchets shared setup, tagged test execution, and aggregation", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const job = workflow.jobs["shared-e2e"];
      job.env!.CHECK_DOC_LINKS_REMOTE = "1";
      job.steps!.find((step) => step.name === "Run tagged credential-free test")!.run =
        "echo skipped";
      workflow.jobs["report-to-pr"].needs = workflow.jobs["report-to-pr"].needs!.filter(
        (name) => name !== "shared-e2e",
      );
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "shared E2E job must set CHECK_DOC_LINKS_REMOTE to 0",
        'step \'Run tagged credential-free test\' run script must include npx vitest run --project "${TEST_PROJECT}" "${TEST_FILE}"',
        "report-to-pr job must wait for shared-e2e",
      ]),
    );
  });

  it("reports a missing shared job as a contract error", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      delete workflow.jobs["shared-e2e"];
    });

    expect(errors).toContain("workflow missing shared E2E job");
  });
});
