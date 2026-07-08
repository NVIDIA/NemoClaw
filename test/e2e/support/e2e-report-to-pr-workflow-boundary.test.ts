// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";
import YAML from "yaml";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";

function readWorkflow(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(path.join(process.cwd(), ".github/workflows/e2e.yaml"), "utf-8"),
  ) as Record<string, unknown>;
}

it("rejects report-to-pr PR number validation drift", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  const workflow = readWorkflow() as {
    jobs: Record<
      string,
      {
        steps: Array<{
          name?: string;
          with?: {
            script?: string;
          };
        }>;
      }
    >;
  };
  const reportStep = workflow.jobs["report-to-pr"].steps.find(
    (step) => step.name === "Post E2E target results to PR",
  );
  expect(reportStep?.with?.script).toEqual(expect.any(String));
  reportStep!.with!.script = String(reportStep!.with!.script)
    .replace(/\/\^\[1-9\]\[0-9\]\*\$\/\.test\(prNumberInput\)/, "prNumberInput.length > 0")
    .replace("Number(prNumberInput)", "Number.parseInt(prNumberInput, 10)")
    .replace("github.rest.pulls.get", "github.rest.issues.get");
  fs.writeFileSync(workflowPath, YAML.stringify(workflow));

  try {
    expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
      expect.arrayContaining([
        "step 'Post E2E target results to PR' run script must not parse JOB_PR_NUMBER with Number.parseInt",
        "step 'Post E2E target results to PR' run script must validate JOB_PR_NUMBER with an all-digits regex before parsing",
        "step 'Post E2E target results to PR' run script must verify JOB_PR_NUMBER identifies a pull request before commenting",
      ]),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
