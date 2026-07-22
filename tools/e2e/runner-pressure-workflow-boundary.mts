// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  "continue-on-error"?: boolean;
  if?: string;
  name?: string;
  run?: string;
};

const RUNNER_PRESSURE_JOBS = [
  { id: "rebuild-hermes", runStep: "Run Hermes rebuild live test" },
  { id: "rebuild-hermes-stale-base", runStep: "Run Hermes stale-base rebuild live test" },
] as const;

const INITIALIZE_MEASUREMENT_STEP = "Initialize runner comparison evidence";
const SUMMARIZE_MEASUREMENT_STEP = "Summarize runner comparison evidence";
const MCP_MEASUREMENT_CONDITION = "${{ matrix.agent == 'hermes' || matrix.agent == 'deepagents' }}";
const MCP_SUMMARY_CONDITION =
  "${{ always() && (matrix.agent == 'hermes' || matrix.agent == 'deepagents') }}";
const RUNNER_MEASUREMENT_JOBS = [
  {
    id: "common-egress-agent",
    publicationStep: "Upload common-egress agent artifacts",
    runStep: "Run common-egress agent live test",
  },
  {
    id: "rebuild-hermes",
    publicationStep: "Upload Hermes rebuild artifacts",
    runStep: "Run Hermes rebuild live test",
  },
  {
    id: "rebuild-hermes-stale-base",
    publicationStep: "Upload Hermes stale-base rebuild artifacts",
    runStep: "Run Hermes stale-base rebuild live test",
  },
  {
    id: "mcp-bridge",
    publicationStep: "Scan MCP artifacts for fixture credentials",
    runStep: "Run MCP OpenShell provider live test",
  },
] as const;
const RUNNER_MEASUREMENT_JOB_IDS = new Set<string>(
  RUNNER_MEASUREMENT_JOBS.map((contract) => contract.id),
);

function asRecord(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function stepsFor(workflow: WorkflowRecord, jobId: string): WorkflowStep[] {
  const jobs = asRecord(workflow.jobs);
  const job = asRecord(jobs[jobId]);
  return Array.isArray(job.steps) ? (job.steps as WorkflowStep[]) : [];
}

function stepIndex(steps: readonly WorkflowStep[], name: string): number {
  return steps.findIndex((step) => step.name === name);
}

function containsEvery(script: string, fragments: readonly string[]): boolean {
  return fragments.every((fragment) => script.includes(fragment));
}

function validateMeasurementWiring(workflow: WorkflowRecord, errors: string[]): void {
  const jobs = asRecord(workflow.jobs);
  for (const contract of RUNNER_MEASUREMENT_JOBS) {
    const steps = stepsFor(workflow, contract.id);
    const prepare = stepIndex(steps, "Prepare E2E workspace");
    const initialize = stepIndex(steps, INITIALIZE_MEASUREMENT_STEP);
    const run = stepIndex(steps, contract.runStep);
    const summarize = stepIndex(steps, SUMMARIZE_MEASUREMENT_STEP);
    const publication = stepIndex(steps, contract.publicationStep);
    const initializeSteps = steps.filter((step) => step.name === INITIALIZE_MEASUREMENT_STEP);
    const summarySteps = steps.filter((step) => step.name === SUMMARIZE_MEASUREMENT_STEP);
    const initializeStep = initializeSteps[0];
    const summaryStep = summarySteps[0];
    const initializeScript = typeof initializeStep?.run === "string" ? initializeStep.run : "";
    const summaryScript = typeof summaryStep?.run === "string" ? summaryStep.run : "";

    if (
      initializeSteps.length !== 1 ||
      prepare < 0 ||
      initialize !== prepare + 1 ||
      run <= initialize
    ) {
      errors.push(
        `${contract.id} must initialize one runner comparison ledger after workspace preparation and before execution`,
      );
    }
    if (
      !containsEvery(initializeScript, [
        'snapshots_file="$E2E_ARTIFACT_DIR/runner-resource-snapshots.jsonl"',
        'summary_file="$E2E_ARTIFACT_DIR/runner-resource-summary.json"',
        'export E2E_RESOURCE_SNAPSHOTS_FILE="$snapshots_file"',
        'export E2E_RESOURCE_SUMMARY_FILE="$summary_file"',
        "runner-pressure.mts initialize-measurement",
        "E2E_RESOURCE_SNAPSHOTS_FILE=%s",
        "E2E_RESOURCE_SUMMARY_FILE=%s",
        '>> "$GITHUB_ENV"',
      ])
    ) {
      errors.push(
        `${contract.id} must export the exact private runner comparison paths to later test processes`,
      );
    }
    if (
      summarySteps.length !== 1 ||
      summarize !== run + 1 ||
      publication <= summarize ||
      !containsEvery(summaryScript, [
        'export E2E_RESOURCE_SNAPSHOTS_FILE="$E2E_ARTIFACT_DIR/runner-resource-snapshots.jsonl"',
        'export E2E_RESOURCE_SUMMARY_FILE="$E2E_ARTIFACT_DIR/runner-resource-summary.json"',
        "runner-pressure.mts summarize-measurement",
      ])
    ) {
      errors.push(
        `${contract.id} must append a final runner snapshot and summarize before artifact publication`,
      );
    }

    const expectedInitializeCondition =
      contract.id === "mcp-bridge" ? MCP_MEASUREMENT_CONDITION : undefined;
    const expectedSummaryCondition =
      contract.id === "mcp-bridge" ? MCP_SUMMARY_CONDITION : "always()";
    if (
      initializeStep?.if !== expectedInitializeCondition ||
      summaryStep?.if !== expectedSummaryCondition ||
      initializeStep?.["continue-on-error"] !== true ||
      summaryStep?.["continue-on-error"] !== true
    ) {
      errors.push(
        contract.id === "mcp-bridge"
          ? "mcp-bridge runner comparison evidence must be best-effort and limited to Hermes and Deep Agents shards"
          : `${contract.id} runner comparison evidence must remain best-effort after every outcome`,
      );
    }
  }

  for (const [jobId, jobValue] of Object.entries(jobs)) {
    if (RUNNER_MEASUREMENT_JOB_IDS.has(jobId)) continue;
    const serialized = JSON.stringify(jobValue);
    if (
      serialized.includes(INITIALIZE_MEASUREMENT_STEP) ||
      serialized.includes(SUMMARIZE_MEASUREMENT_STEP) ||
      serialized.includes("E2E_RESOURCE_SNAPSHOTS_FILE") ||
      serialized.includes("E2E_RESOURCE_SUMMARY_FILE") ||
      serialized.includes("initialize-measurement") ||
      serialized.includes("summarize-measurement")
    ) {
      errors.push(`runner comparison evidence must not be wired to out-of-scope job ${jobId}`);
    }
  }

  const mcpRunStep = stepsFor(workflow, "mcp-bridge").find(
    (step) => step.name === "Run MCP OpenShell provider live test",
  );
  const mcpScript = typeof mcpRunStep?.run === "string" ? mcpRunStep.run : "";
  const mainTest = mcpScript.indexOf(
    "live-vitest-invocation.mts run --test-path test/e2e/live/mcp-bridge.test.ts",
  );
  const deepAgentsGuard = mcpScript.indexOf(
    'if [[ "$NEMOCLAW_MCP_BRIDGE_AGENT" == "deepagents" ]]',
  );
  const credentialWindow = mcpScript.indexOf(
    "test/e2e/live/openshell-credential-generation-window.test.ts",
  );
  const serializedRegion =
    mainTest >= 0 && credentialWindow > mainTest ? mcpScript.slice(mainTest, credentialWindow) : "";
  if (
    mainTest < 0 ||
    deepAgentsGuard <= mainTest ||
    credentialWindow <= deepAgentsGuard ||
    !mcpScript.slice(credentialWindow).includes("--no-file-parallelism") ||
    /(?:^|[^&])&(?!&)/u.test(serializedRegion)
  ) {
    errors.push(
      "mcp-bridge Deep Agents runner comparison tests must remain serialized in one job ledger",
    );
  }
}

/**
 * Protect the canonical #7101 Hermes heartbeat integration from becoming an
 * emit-only diagnostic. Ordinary failures must produce, consume, and upload
 * one validated classification while preserving the original test status.
 */
export function validateRunnerPressureWorkflow(workflowValue: unknown): string[] {
  const workflow = asRecord(workflowValue);
  const errors: string[] = [];
  for (const contract of RUNNER_PRESSURE_JOBS) {
    const steps = stepsFor(workflow, contract.id);
    const runStep = steps.find((step) => step.name === contract.runStep);
    const script = typeof runStep?.run === "string" ? runStep.run : "";
    const snapshot = script.indexOf("runner-pressure.mts snapshot");
    const initializeEvidence = script.indexOf("runner-pressure.mts initialize-evidence");
    const liveTest = script.indexOf("live-vitest-invocation.mts run");
    const classify = script.indexOf("runner-pressure.mts classify");
    const validateClassification = script.indexOf("runner-pressure.mts validate-classification");

    if (
      snapshot < 0 ||
      initializeEvidence <= snapshot ||
      liveTest <= initializeEvidence ||
      !script.includes('baseline_file="$E2E_ARTIFACT_DIR/runner-pressure-baseline.jsonl"') ||
      !script.includes(
        'phase_baselines_file="$E2E_ARTIFACT_DIR/runner-pressure-phase-baselines.jsonl"',
      ) ||
      !script.includes('export E2E_RESOURCE_BASELINE_FILE="$baseline_file"') ||
      !script.includes('export E2E_RESOURCE_PHASE_BASELINES_FILE="$phase_baselines_file"') ||
      !script.includes('export E2E_TERMINAL_CLASSIFICATION_FILE="$classification_file"') ||
      script.includes('>"$baseline_file"') ||
      script.includes('>"$phase_baselines_file"') ||
      script.includes('tee "$classification_file"')
    ) {
      errors.push(
        `${contract.id} must emit snapshots and retain immutable workflow plus append-only phase baselines before its live test`,
      );
    }

    if (
      !script.includes('test_outcome_file="$E2E_ARTIFACT_DIR/live-test-outcome.json"') ||
      !script.includes('export E2E_TEST_OUTCOME_FILE="$test_outcome_file"') ||
      script.indexOf('export E2E_TEST_OUTCOME_FILE="$test_outcome_file"') >= liveTest ||
      script.includes("TEST_OUTCOME=none")
    ) {
      errors.push(
        `${contract.id} must propagate the trusted live-harness assertion or timeout outcome into terminal classification`,
      );
    }

    if (
      classify <= liveTest ||
      validateClassification <= classify ||
      !script.includes(
        'classification_file="$E2E_ARTIFACT_DIR/runner-pressure-classification.jsonl"',
      ) ||
      script.indexOf('export E2E_TERMINAL_CLASSIFICATION_FILE="$classification_file"') >=
        liveTest ||
      !script.includes('test_status="$?"') ||
      !script.includes('exit "$test_status"')
    ) {
      errors.push(
        `${contract.id} must fail closed on a missing or malformed terminal classification while preserving the live-test status`,
      );
    }

    const upload = steps.find((step) => step.name?.startsWith("Upload Hermes"));
    if (upload?.if !== "always()") {
      errors.push(`${contract.id} must upload runner-pressure evidence after every outcome`);
    }
  }
  validateMeasurementWiring(workflow, errors);
  return errors;
}
