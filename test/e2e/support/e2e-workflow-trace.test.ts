// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateStandardProfileWorkflowBoundary } from "../../../tools/e2e/standard-profile-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type E2eWorkflow = {
  jobs: Record<string, { name?: string; steps: Array<Record<string, unknown>> }>;
};

function liveStep(workflow: E2eWorkflow, name: string): Record<string, unknown> {
  const step = workflow.jobs.run.steps.find((entry) => entry.name === name);
  expect(step).toEqual(expect.any(Object));
  return step!;
}

describe("e2e workflow live job boundary", () => {
  it.each([
    "Configure live E2E trace directory",
    "Build trusted live E2E timing summary",
    "Delete raw live E2E traces",
  ])("rejects a missing live trace boundary step: %s", (name) => {
    const workflow = YAML.parse(
      fs.readFileSync(".github/workflows/e2e-standard-profile.yaml", "utf8"),
    ) as E2eWorkflow;
    workflow.jobs.run.steps = workflow.jobs.run.steps.filter((step) => step.name !== name);
    const errors = validateStandardProfileWorkflowBoundary(readWorkflow(), workflow);

    expect(errors).toContain(`standard E2E profile must define one '${name}' step`);
  });

  it("rejects live sanitizer and cleanup steps without always guards", () => {
    const workflow = YAML.parse(
      fs.readFileSync(".github/workflows/e2e-standard-profile.yaml", "utf8"),
    ) as E2eWorkflow;
    liveStep(workflow, "Build trusted live E2E timing summary").if = undefined;
    liveStep(workflow, "Delete raw live E2E traces").if = undefined;
    const errors = validateStandardProfileWorkflowBoundary(readWorkflow(), workflow);

    expect(errors).toEqual(
      expect.arrayContaining([
        "live trace sanitizer must always run",
        "live trace raw trace cleanup must always run",
      ]),
    );
  });

  it("rejects live trace setup after workspace preparation", () => {
    const workflow = YAML.parse(
      fs.readFileSync(".github/workflows/e2e-standard-profile.yaml", "utf8"),
    ) as E2eWorkflow;
    const steps = workflow.jobs.run.steps;
    const configureIndex = steps.findIndex(
      (step) => step.name === "Configure live E2E trace directory",
    );
    const [configureStep] = steps.splice(configureIndex, 1);
    const prepareIndex = steps.findIndex((step) => step.name === "Prepare E2E workspace");
    steps.splice(prepareIndex + 1, 0, configureStep);
    const errors = validateStandardProfileWorkflowBoundary(readWorkflow(), workflow);

    expect(errors).toContain(
      "live trace setup, workspace preparation, Vitest run, sanitizer, and cleanup steps must stay in order",
    );
  });

  it("rejects live trace sanitizer without the workflow-owned source guard", () => {
    const workflow = YAML.parse(
      fs.readFileSync(".github/workflows/e2e-standard-profile.yaml", "utf8"),
    ) as E2eWorkflow;
    const sanitizeStep = liveStep(workflow, "Build trusted live E2E timing summary");
    sanitizeStep.run = String(sanitizeStep.run)
      .replace('expected_trace_dir="${RUNNER_TEMP}/nemoclaw-e2e-traces/${TARGET_ID}"\n', "")
      .replace(TRACE_SOURCE_GUARD, "");
    const errors = validateStandardProfileWorkflowBoundary(readWorkflow(), workflow);

    expect(errors).toContain(
      "typed trace sanitizer must reject a foreign trace directory before accessing it",
    );
  });

  it("rejects live trace sanitizer when the source guard moves after Python reads traces", () => {
    const workflow = YAML.parse(
      fs.readFileSync(".github/workflows/e2e-standard-profile.yaml", "utf8"),
    ) as E2eWorkflow;
    const sanitizeStep = liveStep(workflow, "Build trusted live E2E timing summary");
    sanitizeStep.run =
      String(sanitizeStep.run).replace(TRACE_SOURCE_ASSIGNMENT + TRACE_SOURCE_GUARD, "") +
      TRACE_SOURCE_ASSIGNMENT +
      TRACE_SOURCE_GUARD;
    const errors = validateStandardProfileWorkflowBoundary(readWorkflow(), workflow);

    expect(errors).toContain(
      "typed trace sanitizer must reject a foreign trace directory before accessing it",
    );
  });

  it("rejects live trace sanitizer script path drift", () => {
    const workflow = YAML.parse(
      fs.readFileSync(".github/workflows/e2e-standard-profile.yaml", "utf8"),
    ) as E2eWorkflow;
    const sanitizeStep = liveStep(workflow, "Build trusted live E2E timing summary");
    sanitizeStep.run = String(sanitizeStep.run).replace(
      "scripts/e2e/sanitize-trace-timing.py",
      "scripts/e2e/renamed-sanitize-trace-timing.py",
    );
    const errors = validateStandardProfileWorkflowBoundary(readWorkflow(), workflow);

    expect(errors).toContain(
      "typed trace sanitizer must reject a foreign trace directory before accessing it",
    );
  });
});

const TRACE_SOURCE_ASSIGNMENT =
  'expected_trace_dir="${RUNNER_TEMP}/nemoclaw-e2e-traces/${TARGET_ID}"\n';
const TRACE_SOURCE_GUARD =
  'if [ -z "${RUNNER_TEMP}" ] || [ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ]; then\n' +
  '  echo "::error title=E2E trace sanitization refused::NEMOCLAW_TRACE_DIR does not match its workflow-owned RUNNER_TEMP path. No raw traces were read or uploaded. Correct the trace path configuration before rerunning." >&2\n' +
  "  printf 'Expected trace path: %s\\n' \"${expected_trace_dir}\" >&2\n" +
  "  exit 1\n" +
  "fi\n";
