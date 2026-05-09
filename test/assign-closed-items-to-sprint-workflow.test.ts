// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = ".github/workflows/assign-closed-items-to-sprint.yaml";
const APP_TOKEN_SHA = "1b10c78c7865c340bc4f6099eb2f838309f1e8c3";

type Workflow = {
  on?: {
    issues?: { types?: string[] };
    pull_request_target?: { types?: string[] };
    schedule?: Array<{ cron?: string }>;
    workflow_dispatch?: {
      inputs?: Record<string, { default?: unknown; type?: string }>;
    };
  };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      steps?: Array<{ name?: string; uses?: string; run?: string }>;
    }
  >;
};

function workflowText(): string {
  return readFileSync(join(REPO_ROOT, WORKFLOW_PATH), "utf-8");
}

function loadWorkflow(): Workflow {
  return YAML.parse(workflowText()) as Workflow;
}

function steps(
  workflow: Workflow,
): Array<{ name?: string; uses?: string; run?: string }> {
  const jobs = workflow.jobs ?? {};
  return Object.values(jobs).flatMap((job) => job.steps ?? []);
}

describe("closed-item Sprint assignment workflow", () => {
  it("runs on closed issues, closed pull requests, schedule, and manual dispatch", () => {
    const workflow = loadWorkflow();

    expect(workflow.on?.issues?.types).toEqual(["closed"]);
    expect(workflow.on?.pull_request_target?.types).toEqual(["closed"]);
    expect(workflow.on?.schedule).toEqual([{ cron: "43 * * * *" }]);

    const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
    expect(inputs.lookback_days?.default).toBe("30");
    expect(inputs.dry_run?.type).toBe("boolean");
    expect(inputs.dry_run?.default).toBe(true);
  });

  it("uses explicit minimal GITHUB_TOKEN permissions", () => {
    const workflow = loadWorkflow();

    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("uses a pinned GitHub App token action instead of actions/add-to-project", () => {
    const raw = workflowText();
    const allSteps = steps(loadWorkflow());

    expect(raw).not.toContain("actions/add-to-project");
    expect(
      allSteps.some(
        (step) => step.uses === `actions/create-github-app-token@${APP_TOKEN_SHA}`,
      ),
    ).toBe(true);
  });

  it("does not check out repository or pull request code", () => {
    const allSteps = steps(loadWorkflow());

    expect(
      allSteps.filter((step) => step.uses?.startsWith("actions/checkout@")),
    ).toEqual([]);
  });

  it("does not interpolate issue or pull request titles and bodies into shell", () => {
    const raw = workflowText();

    expect(raw).not.toMatch(
      /\$\{\{\s*github\.event\.(issue|pull_request)\.(title|body)\s*}}/,
    );
    expect(raw).not.toMatch(/\b(issue|pull_request)[_-](title|body)\b/i);
  });

  it("has bash-valid embedded shell", () => {
    const assignStep = steps(loadWorkflow()).find(
      (step) => step.name === "Assign missing Sprint to closed items",
    );

    expect(assignStep?.run).toBeTruthy();

    const result = spawnSync("bash", ["-n"], {
      input: assignStep?.run ?? "",
      encoding: "utf-8",
    });

    expect(result.status, result.stderr).toBe(0);
  });
});
