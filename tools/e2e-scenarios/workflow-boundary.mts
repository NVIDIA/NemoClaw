// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e-scenarios.yaml");
const DEFAULT_VITEST_WORKFLOW_PATH = join(
  REPO_ROOT,
  ".github",
  "workflows",
  "e2e-vitest-scenarios.yaml",
);

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

function requireRunDoesNotContain(errors: string[], step: WorkflowStep | undefined, forbidden: string): void {
  if (!step) return;
  if (stringValue(step.run).includes(forbidden)) {
    errors.push(`step '${step.name ?? "<unnamed>"}' run script must not include ${forbidden}`);
  }
}

function requireWorkflowDispatch(errors: string[], triggers: WorkflowRecord): WorkflowRecord {
  const workflowDispatch = asRecord(triggers.workflow_dispatch);
  if (Object.keys(workflowDispatch).length === 0) errors.push("workflow must support workflow_dispatch");
  return workflowDispatch;
}

function rejectAutomaticTriggers(errors: string[], triggers: WorkflowRecord): void {
  for (const unsafe of ["push", "pull_request", "pull_request_target", "schedule"]) {
    if (Object.hasOwn(triggers, unsafe)) errors.push(`workflow must not run on ${unsafe}`);
  }
}

function requireFullShaAction(errors: string[], step: WorkflowStep | undefined, description: string): void {
  if (!step) return;
  if (!/@[0-9a-f]{40}$/i.test(stringValue(step.uses))) {
    errors.push(`${description} action must be pinned to a full commit SHA`);
  }
}

function requireNoDispatchInputInterpolation(
  errors: string[],
  steps: readonly WorkflowStep[],
): void {
  const expressionPattern = /\$\{\{\s*(?:inputs|github\.event\.inputs)\s*(?:\.|\[)/;
  for (const step of steps) {
    if (expressionPattern.test(stringValue(step.run))) {
      errors.push(
        `step '${step.name ?? "<unnamed>"}' run script must not interpolate dispatch inputs directly`,
      );
    }
  }
}

export function validateE2eScenariosWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  const workflow = asRecord(YAML.parse(readFileSync(workflowPath, "utf-8")));
  const errors: string[] = [];
  const triggers = asRecord(workflow.on ?? workflow[true as unknown as string]);

  const workflowDispatch = requireWorkflowDispatch(errors, triggers);
  const workflowCall = asRecord(triggers.workflow_call);
  if (Object.keys(workflowCall).length === 0) errors.push("workflow must support workflow_call");
  rejectAutomaticTriggers(errors, triggers);

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
  // The TS runner has one execution mode: live. Workflows must not pass
  // --dry-run, --plan-only, or --validate-only — they hide real test runs.
  requireRunDoesNotContain(errors, normalRun, "--dry-run");
  requireRunDoesNotContain(errors, normalRun, "--plan-only");
  requireRunDoesNotContain(errors, normalRun, "--validate-only");

  const wslInstall = requireStep(errors, steps, "Ensure Ubuntu WSL exists");
  requireRunContains(errors, wslInstall, "wsl --install");
  requireRunContains(errors, wslInstall, "wsl --set-default");

  const wslDeps = requireStep(errors, steps, "Install Ubuntu dependencies");
  requireRunContains(errors, wslDeps, "apt-get install");
  requireRunContains(errors, wslDeps, "rsync");

  const wslNode = requireStep(errors, steps, "Install Node.js 22 in WSL");
  requireRunContains(errors, wslNode, "setup_22.x");
  requireRunContains(errors, wslNode, "npm --version");

  const wslWorkspace = requireStep(errors, steps, "Copy checkout into WSL ext4 workspace");
  requireRunContains(errors, wslWorkspace, "rsync -a");
  requireRunContains(errors, wslWorkspace, "WSL ext4 workspace ready");

  const wslRun = requireStep(errors, steps, "Run typed scenarios in WSL");
  requireRunContains(errors, wslRun, "npx tsx test/e2e-scenario/scenarios/run.ts");
  requireRunContains(errors, wslRun, "--scenarios");
  // From this PR: the typed runner is the only execution path; the
  // bash runner / dry-run / validate-only / plan-only modes are
  // removed from CI.
  requireRunDoesNotContain(errors, wslRun, "--dry-run");
  requireRunDoesNotContain(errors, wslRun, "--plan-only");
  requireRunDoesNotContain(errors, wslRun, "--validate-only");
  // From main (#4346): the WSL step must use the robust PowerShell
  // wrapper that materializes a bash script, copies it into WSL via
  // wslpath, and invokes it with `bash -l` so Docker WSL integration
  // and Ubuntu first-run races are handled.
  requireRunContains(errors, wslRun, "$env:WSL_WORKDIR");
  requireRunContains(errors, wslRun, "WriteAllText");
  requireRunContains(errors, wslRun, "bash -l $wslTmp");

  const upload = requireStep(errors, steps, "Upload scenario artifacts");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-scenario-${{ inputs.scenarios || github.event.inputs.scenarios }}") {
    errors.push("artifact upload name must include the scenarios input");
  }
  // Framework-owned secret hygiene: include-hidden-files MUST be false.
  // Hidden dotfiles under the workspace can carry raw secrets (notably
  // .e2e/context.env, written by e2e_context_set without redaction).
  // The redacted surfaces are explicit subpaths under .e2e/ that the
  // framework writes via orchestrators/redaction.ts::pipeRedacted.
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("artifact upload must set include-hidden-files: false (raw context.env must not leak)");
  }
  const uploadPath = stringValue(uploadWith.path);
  if (!uploadPath.includes(".e2e/actions/")) {
    errors.push("artifact upload path must include .e2e/actions/ (redacted action evidence)");
  }
  if (!uploadPath.includes(".e2e/logs/")) {
    errors.push("artifact upload path must include .e2e/logs/ (redacted shell-step evidence)");
  }
  // Bare blanket '.e2e/' (without a trailing subdir) would re-include
  // the raw context.env file. Reject it so the explicit-subpath
  // contract stays honest. Subpaths like '.e2e/actions/' are fine.
  for (const line of uploadPath.split("\n")) {
    if (line.trim() === ".e2e/") {
      errors.push("artifact upload path must not list bare .e2e/ (use explicit subpaths to avoid context.env leakage)");
    }
  }

  return errors;
}

export function validateE2eVitestScenariosWorkflowBoundary(
  workflowPath = DEFAULT_VITEST_WORKFLOW_PATH,
): string[] {
  const workflow = asRecord(YAML.parse(readFileSync(workflowPath, "utf-8")));
  const errors: string[] = [];
  const triggers = asRecord(workflow.on ?? workflow[true as unknown as string]);

  const workflowDispatch = requireWorkflowDispatch(errors, triggers);
  rejectAutomaticTriggers(errors, triggers);

  const dispatchInputs = asRecord(workflowDispatch.inputs);
  requireInput(errors, dispatchInputs, "scenarios");
  if (Object.hasOwn(dispatchInputs, "test_filter")) {
    errors.push("workflow_dispatch must not expose legacy test_filter input");
  }

  const permissions = asRecord(workflow.permissions);
  if (permissions.contents !== "read") errors.push("workflow permissions.contents must be read");

  const jobs = asRecord(workflow.jobs);
  const generateMatrix = asRecord(jobs["generate-matrix"]);
  if (Object.keys(generateMatrix).length === 0) errors.push("workflow missing generate-matrix job");
  if (generateMatrix["runs-on"] !== "ubuntu-latest") {
    errors.push("generate-matrix job must run on ubuntu-latest");
  }
  const generateSteps = asSteps(generateMatrix.steps);
  requireNoDispatchInputInterpolation(errors, generateSteps);
  const generateCheckout = generateSteps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!generateCheckout) errors.push("generate-matrix job missing checkout step");
  requireFullShaAction(errors, generateCheckout, "generate-matrix checkout");
  if (asRecord(generateCheckout?.with)["persist-credentials"] !== false) {
    errors.push("generate-matrix checkout step must set persist-credentials=false");
  }
  const generateSetupNode = namedStep(generateSteps, "Set up Node");
  if (!generateSetupNode) errors.push("generate-matrix job missing step: Set up Node");
  requireFullShaAction(errors, generateSetupNode, "generate-matrix setup-node");
  const generate = requireStep(errors, generateSteps, "Generate Vitest scenario matrix");
  const generateEnv = asRecord(generate?.env);
  if (generateEnv.SCENARIOS !== "${{ inputs.scenarios }}") {
    errors.push("matrix generation step must pass scenarios through SCENARIOS env");
  }
  requireRunContains(errors, generate, "npx tsx test/e2e-scenario/scenarios/run.ts");
  requireRunContains(errors, generate, "--emit-live-matrix");
  requireRunContains(errors, generate, "--scenarios");
  requireRunContains(errors, generate, "^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$");
  requireRunDoesNotContain(errors, generate, "^[A-Za-z0-9._-]+");

  const liveScenarios = asRecord(jobs["live-scenarios"]);
  if (Object.keys(liveScenarios).length === 0) errors.push("workflow missing live-scenarios job");
  if (liveScenarios["runs-on"] !== "${{ matrix.runner }}") {
    errors.push("live-scenarios job must run on the matrix runner");
  }
  if (liveScenarios.needs !== "generate-matrix") {
    errors.push("live-scenarios job must depend on generate-matrix");
  }
  const strategy = asRecord(liveScenarios.strategy);
  if (strategy["fail-fast"] !== false) {
    errors.push("live-scenarios strategy.fail-fast must be false");
  }
  const matrix = asRecord(strategy.matrix);
  if (matrix.include !== "${{ fromJSON(needs.generate-matrix.outputs.matrix) }}") {
    errors.push("live-scenarios matrix.include must come from generate-matrix output");
  }

  const jobEnv = asRecord(liveScenarios.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("live-scenarios job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (!stringValue(jobEnv.E2E_ARTIFACT_DIR).includes("e2e-artifacts/vitest")) {
    errors.push("live-scenarios job must write artifacts under e2e-artifacts/vitest");
  }
  if (!stringValue(jobEnv.E2E_ARTIFACT_DIR).includes("${{ matrix.id }}")) {
    errors.push("live-scenarios artifacts must be scoped by matrix.id");
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push("live-scenarios job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }

  const steps = asSteps(liveScenarios.steps);
  requireNoDispatchInputInterpolation(errors, steps);

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("live-scenarios job missing checkout step");
  requireFullShaAction(errors, checkout, "checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("checkout step must set persist-credentials=false");
  }

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("live-scenarios job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "setup-node");

  const buildCli = requireStep(errors, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const runVitest = requireStep(errors, steps, "Run Vitest live E2E scenarios");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.SCENARIO_ID !== "${{ matrix.id }}") {
    errors.push("Vitest step must pass matrix.id through SCENARIO_ID env");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/registry-scenarios.test.ts");
  requireRunContains(errors, runVitest, '"^${SCENARIO_ID}$"');

  const summary = requireStep(errors, steps, "Summarize artifacts");
  const summaryEnv = asRecord(summary?.env);
  if (summaryEnv.SCENARIO_ID !== "${{ matrix.id }}") {
    errors.push("summary step must pass matrix.id through SCENARIO_ID env");
  }
  if (summaryEnv.SCENARIO_LABEL !== "${{ matrix.label }}") {
    errors.push("summary step must pass matrix.label through SCENARIO_LABEL env");
  }
  requireRunContains(errors, summary, "${SCENARIO_ID}");

  const upload = requireStep(errors, steps, "Upload Vitest E2E artifacts");
  requireFullShaAction(errors, upload, "upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-${{ matrix.id }}") {
    errors.push("artifact upload name must include matrix.id");
  }
  if (uploadWith.path !== "e2e-artifacts/vitest/${{ matrix.id }}/") {
    errors.push("artifact upload path must be non-hidden and scoped by matrix.id");
  }
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("artifact upload must ignore missing fixture artifacts");
  }

  return errors;
}
