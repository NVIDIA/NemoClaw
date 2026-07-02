// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type E2eWorkflow = {
  jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
};

function validateMutatedWorkflow(mutator: (workflow: E2eWorkflow) => void): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  const workflow = readWorkflow() as E2eWorkflow;
  try {
    mutator(workflow);
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));
    return validateE2eWorkflowBoundary(workflowPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function liveStep(workflow: E2eWorkflow, name: string): Record<string, unknown> {
  const step = workflow.jobs.live.steps.find((entry) => entry.name === name);
  expect(step).toEqual(expect.any(Object));
  return step!;
}

describe("e2e workflow live trace boundary", () => {
  it("rejects missing live trace boundary steps", () => {
    for (const name of [
      "Configure live E2E trace directory",
      "Build trusted live E2E timing summary",
      "Delete raw live E2E traces",
    ]) {
      const errors = validateMutatedWorkflow((workflow) => {
        workflow.jobs.live.steps = workflow.jobs.live.steps.filter((step) => step.name !== name);
      });

      expect(errors).toContain(`run-target job missing step: ${name}`);
    }
  });

  it("rejects live sanitizer and cleanup steps without always guards", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      liveStep(workflow, "Build trusted live E2E timing summary").if = undefined;
      liveStep(workflow, "Delete raw live E2E traces").if = undefined;
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "live trace sanitizer must always run",
        "live raw trace cleanup must always run",
      ]),
    );
  });

  it("rejects live trace setup after workspace preparation", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const steps = workflow.jobs.live.steps;
      const configureIndex = steps.findIndex(
        (step) => step.name === "Configure live E2E trace directory",
      );
      expect(configureIndex).toBeGreaterThanOrEqual(0);
      const [configureStep] = steps.splice(configureIndex, 1);
      const prepareIndex = steps.findIndex((step) => step.name === "Prepare E2E workspace");
      expect(prepareIndex).toBeGreaterThanOrEqual(0);
      steps.splice(prepareIndex + 1, 0, configureStep);
    });

    expect(errors).toContain(
      "live trace setup, workspace preparation, Vitest run, sanitizer, and cleanup steps must stay in order",
    );
  });

  it("rejects live trace sanitizer without the workflow-owned source guard", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const sanitizeStep = liveStep(workflow, "Build trusted live E2E timing summary");
      expect(sanitizeStep.run).toEqual(expect.any(String));
      sanitizeStep.run = String(sanitizeStep.run)
        .replace('expected_trace_dir="${RUNNER_TEMP}/nemoclaw-e2e-traces/${TARGET_ID}"\n', "")
        .replace(TRACE_SOURCE_GUARD, "");
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "step 'Build trusted live E2E timing summary' run script must include ${RUNNER_TEMP}/nemoclaw-e2e-traces/${TARGET_ID}",
        'step \'Build trusted live E2E timing summary\' run script must include [ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ]',
      ]),
    );
  });

  it("rejects live trace sanitizer when the source guard moves after Python reads traces", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const sanitizeStep = liveStep(workflow, "Build trusted live E2E timing summary");
      expect(sanitizeStep.run).toEqual(expect.any(String));
      sanitizeStep.run =
        String(sanitizeStep.run).replace(TRACE_SOURCE_ASSIGNMENT + TRACE_SOURCE_GUARD, "") +
        TRACE_SOURCE_ASSIGNMENT +
        TRACE_SOURCE_GUARD;
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "step 'Build trusted live E2E timing summary' run script must include " +
          'expected_trace_dir="${RUNNER_TEMP}/nemoclaw-e2e-traces/${TARGET_ID}" before ' +
          "python3 scripts/e2e/sanitize-trace-timing.py",
        "step 'Build trusted live E2E timing summary' run script must include " +
          '[ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ] before ' +
          "python3 scripts/e2e/sanitize-trace-timing.py",
      ]),
    );
  });

  it("rejects live trace sanitizer script path drift", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const sanitizeStep = liveStep(workflow, "Build trusted live E2E timing summary");
      expect(sanitizeStep.run).toEqual(expect.any(String));
      sanitizeStep.run = String(sanitizeStep.run).replace(
        "scripts/e2e/sanitize-trace-timing.py",
        "scripts/e2e/renamed-sanitize-trace-timing.py",
      );
    });

    expect(errors).toContain(
      "step 'Build trusted live E2E timing summary' run script must include scripts/e2e/sanitize-trace-timing.py",
    );
  });
});

const TRACE_SOURCE_ASSIGNMENT =
  'expected_trace_dir="${RUNNER_TEMP}/nemoclaw-e2e-traces/${TARGET_ID}"\n';
const TRACE_SOURCE_GUARD =
  'if [ -z "${RUNNER_TEMP}" ] || [ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ]; then\n' +
  '  echo "::error::Refusing to sanitize unexpected raw trace path" >&2\n' +
  "  exit 1\n" +
  "fi\n";
