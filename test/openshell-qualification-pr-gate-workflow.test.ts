// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob, type WorkflowStep } from "./helpers/e2e-workflow-contract";

type QualificationWorkflow = {
  jobs: Record<string, WorkflowJob>;
  name: string;
  on: { pull_request_target: { types: string[] } };
  permissions: Record<string, string>;
  "run-name": string;
};

const workflow = readYaml<QualificationWorkflow>(
  ".github/workflows/openshell-0.0.101-pr-gate.yaml",
);

function job(name: string): WorkflowJob {
  const value = workflow.jobs[name];
  assert(value, `missing workflow job ${name}`);
  return value;
}

function step(owner: WorkflowJob, name: string): WorkflowStep {
  const value = owner.steps?.find((candidate) => candidate.name === name);
  assert(value, `missing workflow step ${name}`);
  return value;
}

function sparsePaths(owner: WorkflowJob, stepName: string): string[] {
  const value = step(owner, stepName).with?.["sparse-checkout"];
  assert(typeof value === "string", `${stepName} must declare sparse paths`);
  return value.trim().split("\n");
}

describe("OpenShell qualification draft PR gate workflow", () => {
  it("validates the parsed trust boundary through an executable contract (#8590)", () => {
    const validation = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import fs from "node:fs";
          import YAML from "yaml";
          const workflow = YAML.parse(fs.readFileSync(
            ".github/workflows/openshell-0.0.101-pr-gate.yaml",
            "utf8",
          ));
          assert.deepEqual(Object.keys(workflow.jobs), [
            "classify", "verify-draft", "openshell-qualification",
          ]);
          assert.deepEqual(workflow.on.pull_request_target.types, [
            "opened", "synchronize", "reopened", "edited",
          ]);
          assert.deepEqual(workflow.permissions, {
            contents: "read", "pull-requests": "read",
          });
          const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
          const setups = steps.filter((step) => step.uses?.startsWith("actions/setup-node@"));
          const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
          assert.equal(setups.length, 2);
          assert(setups.every((step) =>
            step.uses === "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"
          ));
          assert.equal(checkouts.length, 3);
          assert(checkouts.every((step) =>
            step.uses === "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
          ));
          const byName = (jobName, stepName) => {
            const found = workflow.jobs[jobName].steps.find((step) => step.name === stepName);
            assert(found);
            return found;
          };
          const paths = (jobName, stepName) =>
            byName(jobName, stepName).with["sparse-checkout"].trim().split("\\n");
          assert.deepEqual(paths("classify", "Checkout base-trusted qualification verifier"), [
            "scripts/checks/openshell-qualification-bootstrap-contract.mts",
            "scripts/checks/openshell-qualification-io.mts",
            "scripts/checks/openshell-qualification-paths.mts",
            "scripts/checks/verify-openshell-qualification-pr-gate.mts",
          ]);
          assert.deepEqual(paths("verify-draft", "Checkout candidate qualification data"), [
            "ci/openshell-0.0.101-qualification-v1.json",
            "nemoclaw-blueprint/blueprint.yaml",
          ]);
          const candidate = byName("verify-draft", "Checkout candidate qualification data");
          assert.equal(candidate.with["persist-credentials"], false);
          assert.equal(candidate.with["allow-unsafe-pr-checkout"], true);
          assert.equal(workflow.jobs["openshell-qualification"].if, "always()");
          assert(steps.filter((step) => step.run).every((step) =>
            !step.run.includes(".candidate-openshell-qualification/scripts/")
          ));
        `,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(validation.status, validation.stderr).toBe(0);
  });

  it.each([
    {
      disposition: "classification failure",
      env: {
        CLASSIFY_RESULT: "failure",
        REQUIRED: "",
        SAME_REPOSITORY: "",
        VERIFY_DRAFT_RESULT: "skipped",
      },
      expectedStatus: 1,
    },
    {
      disposition: "unrelated pull request",
      env: {
        CLASSIFY_RESULT: "success",
        REQUIRED: "false",
        SAME_REPOSITORY: "false",
        VERIFY_DRAFT_RESULT: "skipped",
      },
      expectedStatus: 0,
    },
    {
      disposition: "missing applicability output",
      env: {
        CLASSIFY_RESULT: "success",
        REQUIRED: "",
        SAME_REPOSITORY: "",
        VERIFY_DRAFT_RESULT: "skipped",
      },
      expectedStatus: 1,
    },
    {
      disposition: "malformed applicability output",
      env: {
        CLASSIFY_RESULT: "success",
        REQUIRED: "unknown",
        SAME_REPOSITORY: "true",
        VERIFY_DRAFT_RESULT: "success",
      },
      expectedStatus: 1,
    },
    {
      disposition: "sensitive fork",
      env: {
        CLASSIFY_RESULT: "success",
        REQUIRED: "true",
        SAME_REPOSITORY: "false",
        VERIFY_DRAFT_RESULT: "skipped",
      },
      expectedStatus: 1,
    },
    {
      disposition: "malformed repository output",
      env: {
        CLASSIFY_RESULT: "success",
        REQUIRED: "true",
        SAME_REPOSITORY: "unknown",
        VERIFY_DRAFT_RESULT: "success",
      },
      expectedStatus: 1,
    },
    {
      disposition: "rejected draft",
      env: {
        CLASSIFY_RESULT: "success",
        REQUIRED: "true",
        SAME_REPOSITORY: "true",
        VERIFY_DRAFT_RESULT: "failure",
      },
      expectedStatus: 1,
    },
    {
      disposition: "missing draft verification result",
      env: {
        CLASSIFY_RESULT: "success",
        REQUIRED: "true",
        SAME_REPOSITORY: "true",
        VERIFY_DRAFT_RESULT: "",
      },
      expectedStatus: 1,
    },
    {
      disposition: "verified inert draft",
      env: {
        CLASSIFY_RESULT: "success",
        REQUIRED: "true",
        SAME_REPOSITORY: "true",
        VERIFY_DRAFT_RESULT: "success",
      },
      expectedStatus: 0,
    },
  ])("enforces $disposition behavior (#8590)", ({ env, expectedStatus }) => {
    const report = step(job("openshell-qualification"), "Report qualification decision");
    assert(report.run);
    const result = spawnSync("bash", ["-c", report.run], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

    expect(result.status).toBe(expectedStatus);
  });
});
