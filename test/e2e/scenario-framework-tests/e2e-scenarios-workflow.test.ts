// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github/workflows/e2e-scenarios.yaml");

type AnyRecord = Record<string, unknown>;
type WorkflowStep = {
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: AnyRecord;
};

function loadWorkflow(): AnyRecord {
  expect(fs.existsSync(WORKFLOW_PATH), `workflow missing at ${WORKFLOW_PATH}`).toBe(true);
  const raw = fs.readFileSync(WORKFLOW_PATH, "utf8");
  return yaml.load(raw) as AnyRecord;
}

function workflowJob(workflow: AnyRecord, jobId: string): AnyRecord {
  const jobs = workflow.jobs as Record<string, AnyRecord> | undefined;
  const job = jobs?.[jobId];
  expect(job, `missing workflow job ${jobId}`).toBeTruthy();
  return job ?? {};
}

function workflowSteps(workflow: AnyRecord, jobId: string): WorkflowStep[] {
  const value = workflowJob(workflow, jobId).steps;
  expect(Array.isArray(value), `workflow job ${jobId} missing steps`).toBe(true);
  return (Array.isArray(value) ? value : []) as WorkflowStep[];
}

function namedStep(workflow: AnyRecord, jobId: string, stepName: string): WorkflowStep {
  const step = workflowSteps(workflow, jobId).find((candidate) => candidate.name === stepName);
  expect(step, `missing step '${stepName}' in ${jobId}`).toBeTruthy();
  return step ?? {};
}

function uploadArtifactStep(workflow: AnyRecord, jobId: string, stepName: string): WorkflowStep {
  const step = namedStep(workflow, jobId, stepName);
  expect(step.uses).toMatch(/^actions\/upload-artifact@(?:v4|[a-f0-9]{40})$/);
  return step;
}

describe("e2e-scenarios workflow", () => {
  it("e2e_scenarios_workflow_should_have_dispatch_inputs", () => {
    const wf = loadWorkflow();
    // YAML `on:` parses as the literal key "true" in some parsers — handle both.
    const on = (wf.on ?? wf[true as unknown as string]) as AnyRecord | undefined;
    expect(on, "workflow missing 'on' trigger").toBeTruthy();
    const dispatch = on?.workflow_dispatch as AnyRecord | undefined;
    expect(dispatch, "workflow missing workflow_dispatch").toBeTruthy();
    const inputs = dispatch?.inputs as AnyRecord | undefined;
    expect(inputs).toBeTruthy();
    expect(inputs).toHaveProperty("scenario");
    expect(inputs).not.toHaveProperty("plan_only");
    expect(inputs).toHaveProperty("suite_filter");
  });

  it("e2e_scenarios_workflow_should_call_run_scenario_without_plan_only", () => {
    const wf = loadWorkflow();
    const runScenario = namedStep(wf, "run-scenario", "Run scenario");
    expect(runScenario.run).toContain("bash test/e2e/runtime/run-scenario.sh");
    expect(runScenario.run).not.toContain("--plan-only");
  });

  it("e2e_scenarios_workflow_should_upload_artifacts", () => {
    const wf = loadWorkflow();
    const upload = uploadArtifactStep(wf, "run-scenario", "Upload scenario artifacts");
    expect(upload.with?.name).toBe("e2e-scenario-${{ inputs.scenario }}");
    expect(upload.with?.path).toContain(".e2e/");
    expect(upload.with?.["include-hidden-files"]).toBe(true);
  });

  it("e2e_scenarios_workflow_should_be_manual_only", () => {
    const wf = loadWorkflow();
    const on = (wf.on ?? wf[true as unknown as string]) as AnyRecord | undefined;
    expect(on).toBeTruthy();
    const keys = Object.keys(on ?? {});
    // Manual-only: must not trigger on push, pull_request, or schedule.
    expect(keys).not.toContain("push");
    expect(keys).not.toContain("pull_request");
    expect(keys).not.toContain("schedule");
  });
});
