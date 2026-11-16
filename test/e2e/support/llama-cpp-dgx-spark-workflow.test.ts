// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
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

describe("Spark Express qualification workflow (#14065)", () => {
  it.each(["jobs", "targets"] as const)(
    "selects the protected Spark Express job through %s",
    (selector) => {
      const plan = buildE2eWorkflowPlan({ [selector]: "spark-express-vllm" });
      expect(plan.selectedJobs).toEqual(["spark-express-vllm"]);
      expect(plan.runtimeProvidersByJob).toEqual({ "spark-express-vllm": ["docker"] });
      expect(plan.explicitOnlyJobs).toContain("spark-express-vllm");
      expect(buildE2eWorkflowPlan().selectedJobs).not.toContain("spark-express-vllm");
      expect(validateE2eWorkflow(workflow)).toEqual([]);
      expect(validateE2eOperationsWorkflow(workflow)).toEqual([]);
    },
  );

  it.each([
    ["runs-on", "ubuntu-latest"],
    ["environment", "unprotected"],
    ["permissions", { contents: "write" }],
    ["concurrency", { group: "independent-spark-queue", "cancel-in-progress": true }],
    ["if", "${{ always() }}"],
    ["timeout-minutes", 100],
  ])("rejects an unsafe Spark Express %s", (field, value) => {
    const changed = structuredClone(workflow);
    changed.jobs["spark-express-vllm"][field as string] = value;
    expect(validateE2eWorkflow(changed).join("\n")).toContain("Spark Express");
  });

  it.each([
    [
      "Run Spark Express and Muse qualification",
      "run",
      "^spark-express-vllm:",
      "^dgx-station-express:",
    ],
    ["Upload Spark Express artifacts", "if", "always()", "success()"],
  ])("rejects altered Spark execution or evidence at %s", (name, field, original, replacement) => {
    const changed = structuredClone(workflow);
    const step = changed.jobs["spark-express-vllm"].steps.find((item: any) => item.name === name);
    step[field] = step[field].replace(original, replacement);
    expect(validateE2eWorkflow(changed).join("\n")).toContain("Spark Express");
  });

  it.each([
    ["Check out trusted Spark preparation", "with", { ref: "${{ inputs.checkout_sha }}" }],
    ["Check out Spark candidate", "with", { ref: "${{ github.workflow_sha }}" }],
    ["Remove Docker credentials before candidate checkout", "continue-on-error", true],
    ["Remove Docker credentials before candidate checkout", "if", "failure()"],
    ["Remove Docker credentials before candidate checkout", "run", "true"],
  ])("rejects unsafe Spark credential preparation at %s / %s", (name, field, value) => {
    const changed = structuredClone(workflow);
    const step = changed.jobs["spark-express-vllm"].steps.find((item: any) => item.name === name);
    step[field as string] = value;
    expect(validateE2eWorkflow(changed).join("\n")).toContain("Spark Express");
  });

  it.each([
    ["Check out Spark candidate", "Authenticate to Docker Hub"],
    ["Install OpenShell CLI", "Check out Spark candidate"],
    [
      "Remove Docker credentials before candidate checkout",
      "Run Spark Express and Muse qualification",
    ],
  ])("rejects Spark preparation reordered between %s and %s", (first, second) => {
    const changed = structuredClone(workflow);
    const steps = changed.jobs["spark-express-vllm"].steps;
    const a = steps.findIndex((step: any) => step.name === first);
    const b = steps.findIndex((step: any) => step.name === second);
    [steps[a], steps[b]] = [steps[b], steps[a]];
    expect(validateE2eWorkflow(changed).join("\n")).toContain("Spark Express");
  });

  it.each([
    "${{ secrets.DOCKERHUB_TOKEN }}",
    "${{ toJSON(secrets) }}",
    "${{ sEcReTs['DOCKERHUB_TOKEN'] }}",
  ])("rejects Spark credentials outside trusted authentication through %s", (value) => {
    const changed = structuredClone(workflow);
    changed.jobs["spark-express-vllm"].env.EXTRA_CREDENTIAL = value;
    expect(validateE2eWorkflow(changed).join("\n")).toContain("Spark Express");
    delete changed.jobs["spark-express-vllm"].env.EXTRA_CREDENTIAL;
    changed.jobs["spark-express-vllm"].steps.push({
      name: "Alternate credential delivery",
      run: "candidate-command",
      env: { EXTRA_CREDENTIAL: value },
    });
    expect(validateE2eWorkflow(changed).join("\n")).toContain("Spark Express");
  });

  it.each([0, 7])("forwards the workflow Spark selector and propagates exit %i", (exitCode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark-workflow-"));
    try {
      fs.writeFileSync(path.join(directory, "openshell"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.writeFileSync(
        path.join(directory, "npx"),
        `#!/bin/sh\nprintf '%s\\n' "$@"\nexit ${exitCode}\n`,
        { mode: 0o755 },
      );
      const execution = workflow.jobs["spark-express-vllm"].steps.find(
        (item: any) => item.name === "Run Spark Express and Muse qualification",
      );
      const result = spawnSync("bash", ["-c", execution.run], {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: directory, PATH: `${directory}:/usr/bin:/bin` },
      });
      expect(result.status, result.stderr).toBe(exitCode);
      expect(result.stdout.trim().split("\n")).toEqual([
        "tsx",
        "tools/e2e/live-vitest-invocation.mts",
        "run",
        "--test-path",
        "test/e2e/live/dgx-express.test.ts",
        "--selector",
        "^spark-express-vllm:",
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves the Station controller when selecting Spark", () => {
    expect(buildE2eWorkflowPlan({ jobs: "dgx-station-express" }).selectedJobs).toEqual([
      "dgx-station-express",
    ]);
    expect(() => buildE2eWorkflowPlan({ jobs: "spark-express-vllm,dgx-station-express" })).toThrow(
      "must be selected by itself",
    );
  });
});
