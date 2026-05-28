// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e-scenarios.yaml");

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & { name?: string; run?: string; uses?: string; with?: WorkflowRecord };

function asRecord(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function asSteps(value: unknown): WorkflowStep[] {
  return Array.isArray(value)
    ? (value.filter((entry) => asRecord(entry) === entry) as WorkflowStep[])
    : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function namedStep(steps: readonly WorkflowStep[], name: string): WorkflowStep | undefined {
  return steps.find((step) => step.name === name);
}

function requireInput(errors: string[], inputs: WorkflowRecord, name: string): void {
  if (!Object.hasOwn(inputs, name)) errors.push(`workflow_dispatch missing input: ${name}`);
}

function requireStep(errors: string[], steps: readonly WorkflowStep[], name: string): WorkflowStep | undefined {
  const step = namedStep(steps, name);
  if (!step) errors.push(`run-scenario job missing step: ${name}`);
  return step;
}

function requireRunContains(errors: string[], step: WorkflowStep | undefined, expected: string): void {
  if (!step) return;
  if (!stringValue(step.run).includes(expected)) {
    errors.push(`step '${step.name ?? "<unnamed>"}' run script must include ${expected}`);
  }
}

export function validateE2eScenariosWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  const workflow = asRecord(YAML.parse(readFileSync(workflowPath, "utf-8")));
  const errors: string[] = [];
  const triggers = asRecord(workflow.on ?? workflow[true as unknown as string]);

  const workflowDispatch = asRecord(triggers.workflow_dispatch);
  const workflowCall = asRecord(triggers.workflow_call);
  if (Object.keys(workflowDispatch).length === 0) errors.push("workflow must support workflow_dispatch");
  if (Object.keys(workflowCall).length === 0) errors.push("workflow must support workflow_call");
  for (const unsafe of ["push", "pull_request", "pull_request_target", "schedule"]) {
    if (Object.hasOwn(triggers, unsafe)) errors.push(`workflow must not run on ${unsafe}`);
  }

  const dispatchInputs = asRecord(workflowDispatch.inputs);
  requireInput(errors, dispatchInputs, "scenarios");
  if (Object.hasOwn(dispatchInputs, "scenario")) {
    errors.push("workflow_dispatch must not expose legacy scenario input");
  }
  if (Object.hasOwn(dispatchInputs, "suite_filter")) {
    errors.push("workflow_dispatch must not expose legacy suite_filter input");
  }
  if (Object.hasOwn(dispatchInputs, "plan_only")) {
    errors.push("workflow_dispatch must not expose retired plan_only input");
  }

  const permissions = asRecord(workflow.permissions);
  if (permissions.contents !== "read") errors.push("workflow permissions.contents must be read");

  const jobs = asRecord(workflow.jobs);
  const resolveRunner = asRecord(jobs["resolve-runner"]);
  if (Object.keys(resolveRunner).length === 0) errors.push("workflow missing resolve-runner job");
  const runScenario = asRecord(jobs["run-scenario"]);
  if (Object.keys(runScenario).length === 0) errors.push("workflow missing run-scenario job");
  if (runScenario["runs-on"] !== "${{ needs.resolve-runner.outputs.runner }}") {
    errors.push("run-scenario job must use the resolved runner output");
  }

  const steps = asSteps(runScenario.steps);
  const normalRun = requireStep(errors, steps, "Run typed scenarios");
  requireRunContains(errors, normalRun, "npx tsx test/e2e-scenario/scenarios/run.ts");
  requireRunContains(errors, normalRun, "--scenarios");
  requireRunContains(errors, normalRun, "--dry-run");

  const wslRun = requireStep(errors, steps, "Run typed scenarios in WSL");
  requireRunContains(errors, wslRun, "npx tsx test/e2e-scenario/scenarios/run.ts");
  requireRunContains(errors, wslRun, "--scenarios");
  requireRunContains(errors, wslRun, "--dry-run");

  const upload = requireStep(errors, steps, "Upload scenario artifacts");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-scenario-${{ inputs.scenarios || github.event.inputs.scenarios }}") {
    errors.push("artifact upload name must include the scenarios input");
  }
  if (uploadWith["include-hidden-files"] !== true) {
    errors.push("artifact upload must include hidden .e2e files");
  }
  if (!stringValue(uploadWith.path).includes(".e2e/")) {
    errors.push("artifact upload path must include .e2e/");
  }

  return errors;
}
