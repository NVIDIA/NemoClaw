// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readYaml,
  type CompositeAction,
  type WorkflowJob,
} from "./helpers/e2e-workflow-contract";

type PullRequestWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

function stepRuns(job: WorkflowJob): string[] {
  return (job.steps ?? []).flatMap((step) => (step.run ? [step.run] : []));
}

describe("pull request workflow contract", () => {
  const workflow = readYaml<PullRequestWorkflow>(".github/workflows/pr.yaml");

  it("routes mixed docs and code PRs through the code-check path", () => {
    const filterStep = workflow.jobs.changes.steps?.find(
      (step) => step.id === "filter",
    );

    expect(filterStep?.uses).toContain("dorny/paths-filter");
    expect(filterStep?.with?.["predicate-quantifier"]).toBe("some");
    expect(filterStep?.with?.filters).toContain("code:");
    expect(filterStep?.with?.filters).toContain("!**/*.md");
    expect(filterStep?.with?.filters).toContain("!docs/**");
  });

  it("preserves the basic-checks config validation gate for code PRs", () => {
    const basicChecks = readYaml<CompositeAction>(".github/actions/basic-checks/action.yaml");
    const requiredValidationRun = basicChecks.runs.steps.find(
      (step) => step.name === "Validate config schemas",
    )?.run;

    expect(requiredValidationRun).toBe("npm run validate:configs");
    expect(stepRuns(workflow.jobs["static-checks"])).toContain(requiredValidationRun);
  });

  it("does not run npm lifecycle scripts during pull_request dependency installs", () => {
    for (const jobName of ["build-typecheck", "cli-tests", "plugin-tests"]) {
      const installRun = stepRuns(workflow.jobs[jobName]).find((run) =>
        run.includes("cd nemoclaw && npm install"),
      );

      expect(installRun, `${jobName} plugin install`).toContain(
        "cd nemoclaw && npm install --ignore-scripts",
      );
      expect(installRun, `${jobName} plugin install`).not.toContain(
        "cd nemoclaw && npm install\n",
      );
    }
  });

  it("does not persist checkout credentials in pull_request jobs", () => {
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith("actions/checkout@")) {
          continue;
        }

        expect(step.with?.["persist-credentials"], `${jobName} checkout`).toBe(false);
      }
    }
  });
});
