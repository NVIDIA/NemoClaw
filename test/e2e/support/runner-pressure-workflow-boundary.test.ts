// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateRunnerPressureWorkflow } from "../../../tools/e2e/runner-pressure-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type WorkflowStep = Record<string, unknown> & {
  "continue-on-error"?: boolean;
  if?: string;
  name?: string;
  run?: string;
};
type WorkflowJob = { steps: WorkflowStep[] };
type Workflow = { jobs: Record<string, WorkflowJob> };

const JOBS = ["rebuild-hermes", "rebuild-hermes-stale-base"] as const;
const MEASUREMENT_JOBS = [
  "common-egress-agent",
  "rebuild-hermes",
  "rebuild-hermes-stale-base",
  "mcp-bridge",
] as const;
const INITIALIZE_MEASUREMENT_STEP = "Initialize runner comparison evidence";
const SUMMARIZE_MEASUREMENT_STEP = "Summarize runner comparison evidence";

function loadWorkflow(): Workflow {
  return readWorkflow() as Workflow;
}

function runStep(workflow: Workflow, jobId: (typeof JOBS)[number]): WorkflowStep {
  return workflow.jobs[jobId]!.steps.find((step) => step.name?.startsWith("Run Hermes"))!;
}

function swapStep(workflow: Workflow, jobId: (typeof JOBS)[number]): WorkflowStep {
  return workflow.jobs[jobId]!.steps.find(
    (step) => step.name === "Add swap for Hermes image rebuild",
  )!;
}

function namedStep(workflow: Workflow, jobId: string, name: string): WorkflowStep {
  return workflow.jobs[jobId]!.steps.find((step) => step.name === name)!;
}

describe("runner-pressure E2E workflow boundary (#7146)", () => {
  it("accepts the canonical pressure classification and runner comparison wiring", () => {
    expect(validateRunnerPressureWorkflow(loadWorkflow())).toEqual([]);
  });

  it.each(
    JOBS,
  )("provisions bounded swap before %s starts its memory-heavy image build", (jobId) => {
    const workflow = loadWorkflow();
    const jobSteps = workflow.jobs[jobId]!.steps;
    const provision = swapStep(workflow, jobId);
    const run = runStep(workflow, jobId);

    expect(provision).toBeDefined();
    expect(jobSteps.indexOf(provision)).toBeLessThan(jobSteps.indexOf(run));
    expect(provision.run).toContain("fallocate -l 32G /mnt/nemoclaw-hermes-rebuild.swap");
    expect(provision.run).toContain("chmod 0600 /mnt/nemoclaw-hermes-rebuild.swap");
    expect(provision.run).toContain("mkswap /mnt/nemoclaw-hermes-rebuild.swap");
    expect(provision.run).toContain("swapon /mnt/nemoclaw-hermes-rebuild.swap");
  });

  it("limits job-level comparison evidence to the five larger-runner candidates", () => {
    const workflow = loadWorkflow();
    for (const jobId of MEASUREMENT_JOBS) {
      expect(namedStep(workflow, jobId, INITIALIZE_MEASUREMENT_STEP)).toBeDefined();
      expect(namedStep(workflow, jobId, SUMMARIZE_MEASUREMENT_STEP)).toBeDefined();
    }
    expect(namedStep(workflow, "mcp-bridge", INITIALIZE_MEASUREMENT_STEP).if).toBe(
      "${{ matrix.agent == 'hermes' || matrix.agent == 'deepagents' }}",
    );
    expect(namedStep(workflow, "mcp-bridge", SUMMARIZE_MEASUREMENT_STEP).if).toBe(
      "${{ always() && (matrix.agent == 'hermes' || matrix.agent == 'deepagents') }}",
    );
    const unrelatedJobs = Object.entries(workflow.jobs).filter(
      ([jobId]) => !(MEASUREMENT_JOBS as readonly string[]).includes(jobId),
    );
    for (const [, job] of unrelatedJobs) {
      expect(job.steps.some((step) => step.name === INITIALIZE_MEASUREMENT_STEP)).toBe(false);
      expect(job.steps.some((step) => step.name === SUMMARIZE_MEASUREMENT_STEP)).toBe(false);
    }
  });

  it.each([
    {
      label: "snapshot and phase baselines",
      mutate: (script: string) =>
        script
          .replace("runner-pressure.mts snapshot", "runner-pressure.mts omitted-snapshot")
          .replace("runner-pressure.mts initialize-evidence", "runner-pressure.mts baseline")
          .replace("E2E_RESOURCE_PHASE_BASELINES_FILE", "OMITTED_PHASE_BASELINES_FILE"),
      error:
        "must emit snapshots and retain immutable workflow plus append-only phase baselines before its live test",
    },
    {
      label: "terminal classification consumer",
      mutate: (script: string) =>
        script.replace(
          "runner-pressure.mts validate-classification",
          "runner-pressure.mts omitted-validation",
        ),
      error:
        "must fail closed on a missing or malformed terminal classification while preserving the live-test status",
    },
    {
      label: "trusted assertion and timeout outcome propagation",
      mutate: (script: string) =>
        script.replace("E2E_TEST_OUTCOME_FILE", "OMITTED_TEST_OUTCOME_FILE"),
      error:
        "must propagate the trusted live-harness assertion or timeout outcome into terminal classification",
    },
  ])("rejects missing $label in both representative lanes", ({ mutate, error }) => {
    const workflow = loadWorkflow();
    for (const jobId of JOBS) {
      const step = runStep(workflow, jobId);
      step.run = mutate(step.run!);
    }

    expect(validateRunnerPressureWorkflow(workflow)).toEqual(
      JOBS.map((jobId) => `${jobId} ${error}`),
    );
  });

  it("rejects the old constant none outcome in both representative lanes", () => {
    const workflow = loadWorkflow();
    for (const jobId of JOBS) {
      const step = runStep(workflow, jobId);
      step.run = step.run!.replace(
        "npx tsx tools/e2e/runner-pressure.mts classify",
        "TEST_OUTCOME=none npx tsx tools/e2e/runner-pressure.mts classify",
      );
    }

    expect(validateRunnerPressureWorkflow(workflow)).toEqual(
      JOBS.map(
        (jobId) =>
          `${jobId} must propagate the trusted live-harness assertion or timeout outcome into terminal classification`,
      ),
    );
  });

  it("rejects outcome-dependent evidence uploads", () => {
    const workflow = loadWorkflow();
    for (const jobId of JOBS) {
      const upload = workflow.jobs[jobId]!.steps.find((step) =>
        step.name?.startsWith("Upload Hermes"),
      )!;
      upload.if = "success()";
    }

    expect(validateRunnerPressureWorkflow(workflow)).toEqual(
      JOBS.map((jobId) => `${jobId} must upload runner-pressure evidence after every outcome`),
    );
  });

  it("rejects a missing initializer in every comparison job", () => {
    const workflow = loadWorkflow();
    for (const jobId of MEASUREMENT_JOBS) {
      workflow.jobs[jobId]!.steps = workflow.jobs[jobId]!.steps.filter(
        (step) => step.name !== INITIALIZE_MEASUREMENT_STEP,
      );
    }

    const errors = validateRunnerPressureWorkflow(workflow);
    for (const jobId of MEASUREMENT_JOBS) {
      expect(errors).toContain(
        `${jobId} must initialize one runner comparison ledger after workspace preparation and before execution`,
      );
      expect(errors).toContain(
        `${jobId} must export the exact private runner comparison paths to later test processes`,
      );
    }
  });

  it("rejects mutable or missing comparison artifact paths", () => {
    const workflow = loadWorkflow();
    for (const jobId of MEASUREMENT_JOBS) {
      const initialize = namedStep(workflow, jobId, INITIALIZE_MEASUREMENT_STEP);
      initialize.run = initialize.run!.replaceAll(
        "runner-resource-snapshots.jsonl",
        "mutable-snapshots.jsonl",
      );
    }

    const errors = validateRunnerPressureWorkflow(workflow);
    for (const jobId of MEASUREMENT_JOBS) {
      expect(errors).toContain(
        `${jobId} must export the exact private runner comparison paths to later test processes`,
      );
    }
  });

  it("rejects initialization after lane-specific setup has already started", () => {
    const workflow = loadWorkflow();
    for (const jobId of MEASUREMENT_JOBS) {
      const steps = workflow.jobs[jobId]!.steps;
      const initializeIndex = steps.findIndex((step) => step.name === INITIALIZE_MEASUREMENT_STEP);
      const [initialize] = steps.splice(initializeIndex, 1);
      const runIndex = steps.findIndex((step) => step.name?.startsWith("Run "));
      steps.splice(runIndex, 0, initialize!);
    }

    const errors = validateRunnerPressureWorkflow(workflow);
    for (const jobId of MEASUREMENT_JOBS) {
      expect(errors).toContain(
        `${jobId} must initialize one runner comparison ledger after workspace preparation and before execution`,
      );
    }
  });

  it("rejects summaries that run after artifact scanning or upload", () => {
    const workflow = loadWorkflow();
    const publicationSteps = new Map<string, string>([
      ["common-egress-agent", "Upload common-egress agent artifacts"],
      ["rebuild-hermes", "Upload Hermes rebuild artifacts"],
      ["rebuild-hermes-stale-base", "Upload Hermes stale-base rebuild artifacts"],
      ["mcp-bridge", "Scan MCP artifacts for fixture credentials"],
    ]);
    for (const jobId of MEASUREMENT_JOBS) {
      const steps = workflow.jobs[jobId]!.steps;
      const summaryIndex = steps.findIndex((step) => step.name === SUMMARIZE_MEASUREMENT_STEP);
      const [summary] = steps.splice(summaryIndex, 1);
      const publicationIndex = steps.findIndex((step) => step.name === publicationSteps.get(jobId));
      steps.splice(publicationIndex + 1, 0, summary!);
    }

    const errors = validateRunnerPressureWorkflow(workflow);
    for (const jobId of MEASUREMENT_JOBS) {
      expect(errors).toContain(
        `${jobId} must append a final runner snapshot and summarize before artifact publication`,
      );
    }
  });

  it("rejects comparison evidence that can replace live-test outcomes", () => {
    const workflow = loadWorkflow();
    for (const jobId of MEASUREMENT_JOBS) {
      const initialize = namedStep(workflow, jobId, INITIALIZE_MEASUREMENT_STEP);
      const summary = namedStep(workflow, jobId, SUMMARIZE_MEASUREMENT_STEP);
      initialize["continue-on-error"] = false;
      summary.if = "success()";
      summary["continue-on-error"] = false;
    }

    const errors = validateRunnerPressureWorkflow(workflow);
    for (const jobId of MEASUREMENT_JOBS.filter((jobId) => jobId !== "mcp-bridge")) {
      expect(errors).toContain(
        `${jobId} runner comparison evidence must remain best-effort after every outcome`,
      );
    }
    expect(errors).toContain(
      "mcp-bridge runner comparison evidence must be best-effort and limited to Hermes and Deep Agents shards",
    );
  });

  it("rejects comparison wiring in MCP OpenClaw, dev, or unrelated jobs", () => {
    const workflow = loadWorkflow();
    namedStep(workflow, "mcp-bridge", INITIALIZE_MEASUREMENT_STEP).if = "always()";
    workflow.jobs["mcp-bridge-dev"]!.steps.push({
      name: INITIALIZE_MEASUREMENT_STEP,
      run: "export E2E_RESOURCE_SNAPSHOTS_FILE=unexpected",
    });
    workflow.jobs["shields-config"]!.steps.push({
      name: SUMMARIZE_MEASUREMENT_STEP,
      run: "npx tsx tools/e2e/runner-pressure.mts summarize-measurement",
    });

    const errors = validateRunnerPressureWorkflow(workflow);
    expect(errors).toContain(
      "mcp-bridge runner comparison evidence must be best-effort and limited to Hermes and Deep Agents shards",
    );
    expect(errors).toContain(
      "runner comparison evidence must not be wired to out-of-scope job mcp-bridge-dev",
    );
    expect(errors).toContain(
      "runner comparison evidence must not be wired to out-of-scope job shields-config",
    );
  });

  it.each([
    {
      label: "backgrounding the primary MCP test",
      mutate: (script: string) =>
        script.replace(
          "npx tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/mcp-bridge.test.ts",
          "npx tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/mcp-bridge.test.ts &",
        ),
    },
    {
      label: "backgrounding the primary MCP test without whitespace",
      mutate: (script: string) =>
        script.replace(
          "npx tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/mcp-bridge.test.ts",
          "npx tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/mcp-bridge.test.ts&",
        ),
    },
    {
      label: "parallelizing the Deep Agents follow-up",
      mutate: (script: string) => script.replace("--no-file-parallelism", "--file-parallelism"),
    },
    {
      label: "running the follow-up before the primary test",
      mutate: (script: string) => {
        const main =
          "npx tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/mcp-bridge.test.ts";
        const followUp = "test/e2e/live/openshell-credential-generation-window.test.ts";
        return script
          .replace(main, "PRIMARY_TEST_PLACEHOLDER")
          .replace(followUp, main)
          .replace("PRIMARY_TEST_PLACEHOLDER", followUp);
      },
    },
  ])("rejects $label because the shared ledger requires serialized appends", ({ mutate }) => {
    const workflow = loadWorkflow();
    const run = namedStep(workflow, "mcp-bridge", "Run MCP OpenShell provider live test");
    run.run = mutate(run.run!);

    expect(validateRunnerPressureWorkflow(workflow)).toContain(
      "mcp-bridge Deep Agents runner comparison tests must remain serialized in one job ledger",
    );
  });
});
