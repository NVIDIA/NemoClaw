// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";
import YAML from "yaml";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";

function readWorkflow(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(path.join(process.cwd(), ".github/workflows/e2e.yaml"), "utf-8"),
  ) as Record<string, unknown>;
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parameters: string[]
) => (...args: unknown[]) => Promise<void>;

function reportScript(): string {
  const workflow = readWorkflow() as {
    jobs: Record<string, { steps: Array<{ name?: string; with?: { script?: string } }> }>;
  };
  const step = workflow.jobs["report-to-pr"].steps.find(
    (candidate) => candidate.name === "Post E2E target results to PR",
  );
  expect(step?.with?.script).toEqual(expect.any(String));
  return String(step!.with!.script);
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

it("reports matrix children by logical id and falls back conservatively for a partial API result", async () => {
  const needs = {
    "generate-matrix": { result: "success" },
    hermetic: { result: "failure" },
    live: { result: "skipped" },
  };
  const script = reportScript().replace(
    "const needs = ${{ toJSON(needs) }};",
    `const needs = ${JSON.stringify(needs)};`,
  );
  const createComment = vi.fn(async (_input: { body: string }) => undefined);
  const setFailed = vi.fn();
  const github = {
    paginate: vi.fn(async () => [
      {
        conclusion: "success",
        name: "Hermetic E2E (docs-validation)",
        status: "completed",
      },
    ]),
    rest: {
      actions: { listJobsForWorkflowRun: Symbol("listJobsForWorkflowRun") },
      issues: { createComment },
      pulls: {
        get: vi.fn(async () => ({ data: { state: "open" } })),
        list: vi.fn(),
      },
    },
  };
  const context = {
    ref: "refs/heads/main",
    repo: { owner: "NVIDIA", repo: "NemoClaw" },
    runId: 123,
    serverUrl: "https://github.com",
  };
  const core = { info: vi.fn(), setFailed, warning: vi.fn() };
  const processStub = {
    env: {
      EXPLICIT_ONLY_JOBS: "",
      HERMETIC_MATRIX: JSON.stringify([
        {
          id: "docs-validation",
          file: "test/e2e/live/docs-validation.test.ts",
          project: "e2e-live",
        },
        {
          id: "onboard-negative-paths",
          file: "test/e2e/live/onboard-negative-paths.test.ts",
          project: "e2e-live",
        },
      ]),
      JOB_PR_NUMBER: "42",
      JOB_TARGETS: "",
      JOBS: "docs-validation,onboard-negative-paths",
    },
  };

  await new AsyncFunction("github", "context", "core", "process", script)(
    github,
    context,
    core,
    processStub,
  );

  expect(setFailed).not.toHaveBeenCalled();
  expect(createComment).toHaveBeenCalledOnce();
  const body = createComment.mock.calls[0]?.[0]?.body as string;
  expect(body).toContain("| docs-validation | ✅ success |");
  expect(body).toContain("| onboard-negative-paths | ❌ failure |");
  expect(body).toContain("Some jobs failed");
  expect(body).not.toContain("not reported");
});
