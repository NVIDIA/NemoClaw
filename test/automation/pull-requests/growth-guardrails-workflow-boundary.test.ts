// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateGrowthGuardrailsWorkflowBoundary } from "../../../scripts/checks/growth-guardrails-workflow-boundary.mts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const WORKFLOW_SOURCE = readFileSync(
  path.join(ROOT, ".github/workflows/codebase-growth-guardrails.yaml"),
  "utf8",
);
const STATIC_ACTION_SOURCE = readFileSync(
  path.join(ROOT, ".github/actions/ci-static-checks/action.yaml"),
  "utf8",
);

type Value = Record<string, any>;

function mutatedWorkflow(mutate: (workflow: Value) => void): string[] {
  const workflow = YAML.parse(WORKFLOW_SOURCE) as Value;
  mutate(workflow);
  return validateGrowthGuardrailsWorkflowBoundary(YAML.stringify(workflow), STATIC_ACTION_SOURCE);
}

describe("codebase growth guardrails workflow trust boundary", () => {
  it("accepts the checked-in trusted workflow configuration", () => {
    expect(validateGrowthGuardrailsWorkflowBoundary()).toEqual([]);
  });

  it("accepts equivalent workflow mappings with reordered keys", () => {
    const workflow = YAML.parse(WORKFLOW_SOURCE) as Value;
    const reorderedWorkflow = {
      jobs: workflow.jobs,
      permissions: {
        "pull-requests": workflow.permissions["pull-requests"],
        contents: workflow.permissions.contents,
      },
      on: workflow.on,
      name: workflow.name,
    };

    expect(
      validateGrowthGuardrailsWorkflowBoundary(
        YAML.stringify(reorderedWorkflow),
        STATIC_ACTION_SOURCE,
      ),
    ).toEqual([]);
  });

  it.each([
    ["trigger", (workflow: Value) => (workflow.on.pull_request = {})],
    ["permissions", (workflow: Value) => (workflow.permissions.contents = "write")],
    [
      "base checkout",
      (workflow: Value) => (workflow.jobs["codebase-growth-guardrails"].steps[0].with.ref = "main"),
    ],
    [
      "checkout pin",
      (workflow: Value) =>
        (workflow.jobs["codebase-growth-guardrails"].steps[0].uses =
          "actions/checkout@0000000000000000000000000000000000000000"),
    ],
    [
      "checkout credentials",
      (workflow: Value) =>
        (workflow.jobs["codebase-growth-guardrails"].steps[0].with["persist-credentials"] = true),
    ],
    [
      "dependency install",
      (workflow: Value) =>
        (workflow.jobs["codebase-growth-guardrails"].steps[1].run = "npm install"),
    ],
    [
      "test invocation",
      (workflow: Value) => (workflow.jobs["codebase-growth-guardrails"].steps[2].run = "npm test"),
    ],
    [
      "pull request metadata",
      (workflow: Value) =>
        (workflow.jobs["codebase-growth-guardrails"].steps[2].env.HEAD_SHA = "untrusted"),
    ],
    [
      "job permission override",
      (workflow: Value) =>
        (workflow.jobs["codebase-growth-guardrails"].permissions = { contents: "write" }),
    ],
    [
      "failure tolerance",
      (workflow: Value) =>
        (workflow.jobs["codebase-growth-guardrails"].steps[2]["continue-on-error"] = true),
    ],
  ])("rejects a mutation to %s", (_boundary, mutate) => {
    expect(mutatedWorkflow(mutate)).toContain(
      "growth guardrail workflow must match the reviewed trust boundary",
    );
  });

  it("rejects recursive test-size checks from the static action", () => {
    const action = YAML.parse(STATIC_ACTION_SOURCE) as Value;
    action.runs.steps.push({ run: "npm run test-size:check", shell: "bash" });
    expect(
      validateGrowthGuardrailsWorkflowBoundary(WORKFLOW_SOURCE, YAML.stringify(action)),
    ).toContain("static checks must not recursively invoke test-size:check");
  });

  it("rejects removal of the reviewed static hook step", () => {
    const action = YAML.parse(STATIC_ACTION_SOURCE) as Value;
    action.runs.steps = action.runs.steps.filter(
      (step: Value) => step.name !== "Run static hook checks",
    );
    expect(
      validateGrowthGuardrailsWorkflowBoundary(WORKFLOW_SOURCE, YAML.stringify(action)),
    ).toContain("static action must retain the reviewed hook-check step");
  });
});
