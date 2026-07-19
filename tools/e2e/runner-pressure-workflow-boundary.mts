// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & { if?: string; name?: string; run?: string };

const RUNNER_PRESSURE_JOBS = [
  { id: "rebuild-hermes", runStep: "Run Hermes rebuild live test" },
  { id: "rebuild-hermes-stale-base", runStep: "Run Hermes stale-base rebuild live test" },
] as const;

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
      script.indexOf('export E2E_TERMINAL_CLASSIFICATION_FILE="$classification_file"') >= liveTest ||
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
  return errors;
}
