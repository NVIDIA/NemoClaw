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
} from "../../../tools/e2e-scenarios/docs-validation-workflow-boundary.mts";
import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  validateE2eVitestScenariosWorkflowBoundary,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

describe("docs validation workflow boundary", () => {
  it("is default-enabled and selectively dispatchable", () => {
    expect(validateDocsValidationWorkflowBoundary()).toEqual([]);
    expect(validateE2eVitestScenariosWorkflowBoundary()).toEqual([]);

    for (const selector of [{ scenarios: "docs-validation" }, { jobs: "docs-validation-vitest" }]) {
      expect(evaluateE2eVitestWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveScenariosRuns: false,
        selectedFreeStandingJobs: ["docs-validation-vitest"],
      });
    }
    expect(evaluateE2eVitestWorkflowDispatchSelectors({}).selectedFreeStandingJobs).toContain(
      "docs-validation-vitest",
    );
  });

  it("makes execution, determinism, and aggregation part of the focused ratchet", () => {
    const workflow = readDocsValidationWorkflow();
    const job = workflow.jobs["docs-validation-vitest"];
    job.env!.CHECK_DOC_LINKS_REMOTE = "1";
    job.steps!.find((step) => step.name === "Run docs validation live Vitest test")!.run =
      "echo skipped";
    workflow.jobs["report-to-pr"].needs = (workflow.jobs["report-to-pr"].needs as string[]).filter(
      (name) => name !== "docs-validation-vitest",
    );

    expect(validateDocsValidationWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "docs-validation-vitest must keep link checks deterministic and local-only",
        "docs-validation-vitest step Run docs validation live Vitest test must contain: test/e2e-scenario/live/docs-validation.test.ts",
        "report-to-pr must wait for docs-validation-vitest",
      ]),
    );

    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-docs-validation-workflow-"));
    const workflowPath = join(directory, "workflow.yaml");
    try {
      writeFileSync(workflowPath, YAML.stringify(workflow));
      expect(validateDocsValidationWorkflowBoundary(workflowPath)).toContain(
        "report-to-pr must wait for docs-validation-vitest",
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
        "docs-validation-vitest must depend on generate-matrix",
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
