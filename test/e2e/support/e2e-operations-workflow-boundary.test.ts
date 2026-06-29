// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readE2eOperationsWorkflow,
  validateE2eOperationsWorkflow,
  validateE2eOperationsWorkflowBoundary,
} from "../../../tools/e2e/operations-workflow-boundary.mts";

describe("E2E operations workflow boundary", () => {
  it("keeps scheduled routing and scorecards aggregated over the report job set", () => {
    expect(validateE2eOperationsWorkflowBoundary()).toEqual([]);

    const workflow = readE2eOperationsWorkflow();
    const reportNeeds = workflow.jobs["report-to-pr"].needs as string[];
    expect(workflow.jobs["notify-on-failure"].needs).toEqual(reportNeeds);
    expect(workflow.jobs.scorecard.needs).toEqual(reportNeeds);
  });

  it("rejects aggregation, permission, and secret-scope drift", () => {
    const workflow = readE2eOperationsWorkflow();
    (workflow.jobs["notify-on-failure"].needs as string[]).pop();
    workflow.jobs["notify-on-failure"].permissions = { contents: "write", issues: "write" };
    workflow.jobs.scorecard.env = {
      SLACK_WEBHOOK_URL_DAILY: "${{ secrets.SLACK_WEBHOOK_URL_DAILY }}",
    };

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "notify-on-failure needs must exactly match report-to-pr needs",
        "notify-on-failure must hold only issues: write",
        "scorecard must not expose credentials at job scope",
      ]),
    );
  });

  it("rejects raw trace upload ordering and advisor auto-dispatch restoration", () => {
    const workflow = readE2eOperationsWorkflow();
    const cloudSteps = workflow.jobs["cloud-onboard"].steps!;
    const sanitize = cloudSteps.find(
      (step) => step.name === "Build trusted cloud-onboard timing summary",
    )!;
    sanitize.run = "cp -R raw-traces e2e-artifacts";

    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-e2e-operations-"));
    const advisorPath = join(directory, "advisor.yaml");
    try {
      writeFileSync(
        advisorPath,
        "permissions:\n  actions: write\njobs:\n  advisor:\n    steps:\n      - run: createWorkflowDispatch()\n",
      );
      expect(validateE2eOperationsWorkflow(workflow, advisorPath)).toEqual(
        expect.arrayContaining([
          "cloud-onboard trace sanitizer must retain scripts/e2e/sanitize-trace-timing.py",
          "E2E advisor must not hold actions: write",
          "E2E advisor must not auto-dispatch workflows",
        ]),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
