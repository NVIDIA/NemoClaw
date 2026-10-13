// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { exportLlamaCppDgxSparkQualificationPlan } from "../../../scripts/checks/export-llama-cpp-dgx-spark-qualification-plan.mts";
import { validateE2eOperationsWorkflow } from "../../../tools/e2e/operations-workflow-boundary.mts";
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";

const root = path.resolve(import.meta.dirname, "../../..");
const workflow = YAML.parse(fs.readFileSync(path.join(root, ".github/workflows/e2e.yaml"), "utf8"));
const planJob = "llama-cpp-dgx-spark-plan";
const runnerJob = "llama-cpp-dgx-spark-qualification";

describe("trusted DGX Spark workflow handoff (#13114)", () => {
  it("accepts the complete authenticated qualification workflow", () => {
    expect(validateE2eOperationsWorkflow(workflow)).toEqual([]);
    expect(validateE2eWorkflow(workflow)).toEqual([]);
    expect(buildE2eWorkflowPlan().selectedJobs).not.toContain(runnerJob);
    expect(buildE2eWorkflowPlan({ jobs: runnerJob }).selectedJobs).toEqual([runnerJob]);
  });

  it("exports a digest-bound execution plan including the pinned Go toolchain", () => {
    const exported = exportLlamaCppDgxSparkQualificationPlan(root);
    expect(JSON.parse(exported.plan).imageBuild.requestGuardToolchain).toMatchObject({
      version: "1.26.9",
    });
  });

  it.each([
    [planJob, "if", "${{ always() }}", "authenticated trusted-main planning"],
    [runnerJob, "needs", "generate-matrix", "authenticated trusted-main planning"],
    [runnerJob, "if", "${{ always() }}", "authenticated trusted-main planning"],
    [runnerJob, "runs-on", "self-hosted", "protected infrastructure"],
    [runnerJob, "environment", "unprotected", "protected infrastructure"],
    [runnerJob, "permissions", { contents: "write" }, "read-only authority"],
    [
      runnerJob,
      "concurrency",
      { group: "shared", "cancel-in-progress": true },
      "protected infrastructure",
    ],
    [runnerJob, "env", { E2E_DEFAULT_ENABLED: "1" }, "authenticated plan"],
  ])("rejects %s %s boundary substitution", (job, field, value, expected) => {
    const changed = structuredClone(workflow);
    changed.jobs[job as string][field as string] = value;
    expect(validateE2eOperationsWorkflow(changed).join("\n")).toContain(expected);
  });

  it.each([
    [
      "Authenticate Spark qualification dispatch",
      '"$ALLOW_QUEUE" == true',
      "true",
      "authentication must retain",
    ],
    [
      "Authenticate Spark qualification dispatch",
      ".head.sha == $head",
      "true",
      "authentication must retain",
    ],
    [
      "Authenticate Spark qualification dispatch",
      ".base.sha == $base",
      "true",
      "authentication must retain",
    ],
    [
      "Export the digest-bound Spark plan",
      "export-llama-cpp-dgx-spark-qualification-plan.mts",
      "candidate.mts",
      "trusted plan exporter",
    ],
  ])("rejects altered planning step %s (%s)", (name, original, replacement, expected) => {
    const changed = structuredClone(workflow);
    const step = changed.jobs[planJob].steps.find((item: any) => item.name === name);
    step.run = step.run.replace(original, replacement);
    expect(validateE2eOperationsWorkflow(changed).join("\n")).toContain(expected);
  });

  it.each([
    ["Run the trusted Spark qualification", "run", "--head-sha", "--wrong-sha", "must pass"],
    ["Run the trusted Spark qualification", "run", "--import tsx", "", "must pass"],
    [
      "Remove owned Spark qualification resources",
      "run",
      "--import tsx",
      "",
      "clean up and validate",
    ],
    ["Run the trusted Spark qualification", "run", "--plan-sha256", "--wrong-digest", "must pass"],
    [
      "Remove owned Spark qualification resources",
      "if",
      "always()",
      "success()",
      "clean up and validate",
    ],
    [
      "Remove owned Spark qualification resources",
      "run",
      "--cleanup-only",
      "--not-cleanup",
      "clean up and validate",
    ],
    [
      "Validate the revision-bound Spark receipt",
      "run",
      "validate-llama-cpp-dgx-spark-receipt.mts",
      "unvalidated.mts",
      "clean up and validate",
    ],
    [
      "Upload validated Spark qualification evidence",
      "if",
      "steps.evidence.outcome == 'success'",
      "true",
      "clean up and validate",
    ],
  ])(
    "rejects altered qualification step %s (%s)",
    (name, field, original, replacement, expected) => {
      const changed = structuredClone(workflow);
      const step = changed.jobs[runnerJob].steps.find((item: any) => item.name === name);
      step[field] = step[field].replace(original, replacement);
      expect(validateE2eOperationsWorkflow(changed).join("\n")).toContain(expected);
    },
  );

  it.each([
    ["continue-on-error", true],
    ["working-directory", ".candidate-source"],
  ])("rejects unsafe qualification step %s", (field, value) => {
    const changed = structuredClone(workflow);
    changed.jobs[runnerJob].steps.find(
      (item: any) => item.name === "Run the trusted Spark qualification",
    )[field as string] = value;
    expect(validateE2eOperationsWorkflow(changed).join("\n")).toContain(
      "must not execute candidate code or ignore step failures",
    );
  });
});
