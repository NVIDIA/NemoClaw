// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  readDocsValidationWorkflow,
  validateDocsValidationWorkflow,
  validateDocsValidationWorkflowBoundary,
} from "../../../tools/e2e/docs-validation-workflow-boundary.mts";
import {
  evaluateE2eWorkflowDispatchSelectors,
  validateE2eWorkflowBoundary,
} from "../../../tools/e2e/workflow-boundary.mts";

describe("docs validation workflow boundary", () => {
  it("is default-enabled and selectively dispatchable", () => {
    expect(validateDocsValidationWorkflowBoundary()).toEqual([]);
    expect(validateE2eWorkflowBoundary()).toEqual([]);

    for (const selector of [{ targets: "docs-validation" }, { jobs: "docs-validation" }]) {
      expect(evaluateE2eWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["docs-validation"],
      });
    }
    expect(evaluateE2eWorkflowDispatchSelectors({}).selectedFreeStandingJobs).toContain(
      "docs-validation",
    );
  });

  it("makes execution, determinism, and aggregation part of the focused ratchet", () => {
    const workflow = readDocsValidationWorkflow();
    const job = workflow.jobs["docs-validation"];
    job.env!.CHECK_DOC_LINKS_REMOTE = "1";
    job.steps!.find((step) => step.name === "Run docs validation live Vitest test")!.run =
      "echo skipped";
    workflow.jobs["report-to-pr"].needs = (workflow.jobs["report-to-pr"].needs as string[]).filter(
      (name) => name !== "docs-validation",
    );

    expect(validateDocsValidationWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "docs-validation must keep link checks deterministic and local-only",
        "docs-validation step Run docs validation live Vitest test must contain: test/e2e/live/docs-validation.test.ts",
        "report-to-pr must wait for docs-validation",
      ]),
    );

    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-docs-validation-workflow-"));
    const workflowPath = join(directory, "workflow.yaml");
    try {
      writeFileSync(workflowPath, YAML.stringify(workflow));
      expect(validateDocsValidationWorkflowBoundary(workflowPath)).toContain(
        "report-to-pr must wait for docs-validation",
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reports empty workflow input as contract errors instead of throwing", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-docs-validation-empty-"));
    const workflowPath = join(directory, "workflow.yaml");
    try {
      writeFileSync(workflowPath, "");
      expect(validateDocsValidationWorkflowBoundary(workflowPath)).toContain(
        "docs-validation must depend on generate-matrix",
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
