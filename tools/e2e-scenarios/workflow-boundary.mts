// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
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

function requireJobStep(
  errors: string[],
  jobName: string,
  steps: readonly WorkflowStep[],
  name: string,
): WorkflowStep | undefined {
  const step = namedStep(steps, name);
  if (!step) errors.push(`${jobName} job missing step: ${name}`);
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

function requireUploadPathContains(errors: string[], uploadPath: string, expected: string): void {
  if (!uploadPath.includes(expected)) {
    errors.push(`artifact upload path must include ${expected}`);
  }
}

function requireEnvDoesNotExposeSecret(
  errors: string[],
  owner: string,
  env: WorkflowRecord,
  secretName: string,
): void {
  if (Object.hasOwn(env, secretName)) {
    errors.push(`${owner} env must not include ${secretName}`);
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

function freeStandingJobIf(jobName: string): string {
  return `\${{ (inputs.jobs == '' && inputs.scenarios == '') || contains(format(',{0},', inputs.jobs), ',${jobName},') }}`;
}

function validateFreeStandingJobSelector(
  errors: string[],
  jobs: WorkflowRecord,
  jobName: string,
): void {
  const job = asRecord(jobs[jobName]);
  if (job.needs !== "validate-jobs") {
    errors.push(`${jobName} job must depend on validate-jobs`);
  }
  if (job.if !== freeStandingJobIf(jobName)) {
    errors.push(`${jobName} job must use the shared jobs selector condition`);
  }
}

function validateJobsSelector(errors: string[], jobs: WorkflowRecord): void {
  const job = asRecord(jobs["validate-jobs"]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing validate-jobs job");
    return;
  }
  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("validate-jobs job must run on ubuntu-latest");
  }
  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  const validate = requireJobStep(errors, "validate-jobs", steps, "Validate free-standing job selector");
  const env = asRecord(validate?.env);
  if (env.JOBS !== "${{ inputs.jobs }}") {
    errors.push("validate-jobs step must pass jobs through JOBS env");
  }
  if (env.SCENARIOS !== "${{ inputs.scenarios }}") {
    errors.push("validate-jobs step must pass scenarios through SCENARIOS env");
  }
  requireRunContains(errors, validate, "Use either scenarios or jobs, not both");
  requireRunContains(errors, validate, "allowed_jobs=");
  requireRunContains(errors, validate, "openshell-version-pin-vitest");
  requireRunContains(errors, validate, "onboard-negative-paths-vitest");
  requireRunContains(errors, validate, "openclaw-tui-chat-correlation-vitest");
  requireRunContains(errors, validate, "gateway-guard-recovery");
  requireRunContains(errors, validate, "^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$");
  requireRunContains(errors, validate, "Invalid jobs input; use comma-separated job ids");
  requireRunDoesNotContain(errors, validate, "Invalid jobs input: ${JOBS}");
  requireRunContains(errors, validate, "Unknown free-standing Vitest job");
}

function validateOpenShellVersionPinVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "openshell-version-pin-vitest";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing openshell-version-pin-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("openshell-version-pin-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName);

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("openshell-version-pin-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !==
    "${{ github.workspace }}/e2e-artifacts/vitest/openshell-version-pin"
  ) {
    errors.push(
      "openshell-version-pin-vitest job must write artifacts under e2e-artifacts/vitest/openshell-version-pin",
    );
  }
  requireEnvDoesNotExposeSecret(errors, "openshell-version-pin-vitest job", jobEnv, "NVIDIA_API_KEY");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    requireEnvDoesNotExposeSecret(
      errors,
      `openshell-version-pin-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`,
      asRecord(step.env),
      "NVIDIA_API_KEY",
    );
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("openshell-version-pin-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "openshell-version-pin-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("openshell-version-pin-vitest checkout step must set persist-credentials=false");
  }

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("openshell-version-pin-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "openshell-version-pin-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const runVitest = requireJobStep(errors, jobName, steps, "Run OpenShell version-pin live test");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/openshell-version-pin.test.ts");

  const upload = requireJobStep(errors, jobName, steps, "Upload OpenShell version-pin artifacts");
  requireFullShaAction(errors, upload, "openshell-version-pin-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-openshell-version-pin") {
    errors.push("openshell-version-pin-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/openshell-version-pin/");
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("openshell-version-pin-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("openshell-version-pin-vitest artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("openshell-version-pin-vitest artifact upload retention-days must be 14");
  }
}


function validateOnboardNegativePathsVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "onboard-negative-paths-vitest";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing onboard-negative-paths-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("onboard-negative-paths-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName);

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("onboard-negative-paths-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !==
    "${{ github.workspace }}/e2e-artifacts/vitest/onboard-negative-paths"
  ) {
    errors.push(
      "onboard-negative-paths-vitest job must write artifacts under e2e-artifacts/vitest/onboard-negative-paths",
    );
  }
  requireEnvDoesNotExposeSecret(errors, "onboard-negative-paths-vitest job", jobEnv, "NVIDIA_API_KEY");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    requireEnvDoesNotExposeSecret(
      errors,
      `onboard-negative-paths-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`,
      asRecord(step.env),
      "NVIDIA_API_KEY",
    );
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("onboard-negative-paths-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "onboard-negative-paths-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("onboard-negative-paths-vitest checkout step must set persist-credentials=false");
  }

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("onboard-negative-paths-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "onboard-negative-paths-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const runVitest = requireJobStep(errors, jobName, steps, "Run onboard negative-paths live test");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/onboard-negative-paths.test.ts");

  const upload = requireJobStep(errors, jobName, steps, "Upload onboard negative-paths artifacts");
  requireFullShaAction(errors, upload, "onboard-negative-paths-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-onboard-negative-paths") {
    errors.push("onboard-negative-paths-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/onboard-negative-paths/");
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("onboard-negative-paths-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("onboard-negative-paths-vitest artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("onboard-negative-paths-vitest artifact upload retention-days must be 14");
  }
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
  requireInput(errors, dispatchInputs, "jobs");
  if (Object.hasOwn(dispatchInputs, "test_filter")) {
    errors.push("workflow_dispatch must not expose legacy test_filter input");
  }

  const permissions = asRecord(workflow.permissions);
  if (permissions.contents !== "read") errors.push("workflow permissions.contents must be read");

  const jobs = asRecord(workflow.jobs);
  validateJobsSelector(errors, jobs);

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
  requireRunContains(errors, generate, "## Vitest E2E Scenario Matrix");
  requireRunContains(errors, generate, "| Scenario | Runner | Label |");

  const liveScenarios = asRecord(jobs["live-scenarios"]);
  if (Object.keys(liveScenarios).length === 0) errors.push("workflow missing live-scenarios job");
  if (liveScenarios["runs-on"] !== "${{ matrix.runner }}") {
    errors.push("live-scenarios job must run on the matrix runner");
  }
  if (liveScenarios.needs !== "generate-matrix") {
    errors.push("live-scenarios job must depend on generate-matrix");
  }
  if (liveScenarios.if !== "${{ inputs.jobs == '' }}") {
    errors.push("live-scenarios job must not run when a free-standing jobs selector is supplied");
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
  if (stringValue(jobEnv.E2E_ARTIFACT_DIR).includes("${{ matrix.id }}")) {
    errors.push("live-scenarios job E2E_ARTIFACT_DIR must be the Vitest artifact parent");
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push("live-scenarios job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  requireEnvDoesNotExposeSecret(errors, "live-scenarios job", jobEnv, "NVIDIA_API_KEY");

  const steps = asSteps(liveScenarios.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Run Vitest live E2E scenarios") {
      requireEnvDoesNotExposeSecret(
        errors,
        `step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "NVIDIA_API_KEY",
      );
    }
  }

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
  if (runVitestEnv.NVIDIA_API_KEY !== "${{ secrets.NVIDIA_API_KEY }}") {
    errors.push("Vitest step must receive NVIDIA_API_KEY from secrets");
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
  requireRunContains(errors, summary, "run-plan.json");
  requireRunContains(errors, summary, 'Path(os.environ["E2E_ARTIFACT_DIR"]) / os.environ["SCENARIO_ID"]');
  requireRunContains(errors, summary, "| Scenario | Manifest | Expected state | Suites | Phases |");
  requireRunContains(errors, summary, "SCENARIO_ID");

  const upload = requireStep(errors, steps, "Upload Vitest E2E artifacts");
  requireFullShaAction(errors, upload, "upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-${{ matrix.id }}") {
    errors.push("artifact upload name must include matrix.id");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/${{ matrix.id }}/run-plan.json");
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/${{ matrix.id }}/scenario.json");
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/vitest/${{ matrix.id }}/scenario-result.json",
  );
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/vitest/${{ matrix.id }}/environment.result.json",
  );
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/vitest/${{ matrix.id }}/onboarding.result.json",
  );
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/vitest/${{ matrix.id }}/state-validation.result.json",
  );
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/${{ matrix.id }}/actions/");
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/${{ matrix.id }}/logs/");
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/${{ matrix.id }}/shell/");
  for (const line of uploadPath.split("\n")) {
    if (line.trim() === "e2e-artifacts/vitest/${{ matrix.id }}/") {
      errors.push("artifact upload path must not list the whole matrix artifact directory");
    }
  }
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("artifact upload retention-days must be 14");
  }

  validateOpenShellVersionPinVitestJob(errors, jobs);
  validateOnboardNegativePathsVitestJob(errors, jobs);
  validateFreeStandingJobSelector(errors, jobs, "openclaw-tui-chat-correlation-vitest");
  validateFreeStandingJobSelector(errors, jobs, "gateway-guard-recovery");

  const reportToPr = asRecord(jobs["report-to-pr"]);
  if (Object.keys(reportToPr).length === 0) {
    errors.push("workflow missing report-to-pr job");
  } else {
    const needs = Array.isArray(reportToPr.needs) ? reportToPr.needs : [];
    for (const required of [
      "validate-jobs",
      "generate-matrix",
      "live-scenarios",
      "openshell-version-pin-vitest",
      "onboard-negative-paths-vitest",
      "openclaw-tui-chat-correlation-vitest",
      "gateway-guard-recovery",
    ]) {
      if (!needs.includes(required)) errors.push(`report-to-pr job must wait for ${required}`);
    }
    const reportSteps = asSteps(reportToPr.steps);
    const report = requireJobStep(errors, "report-to-pr", reportSteps, "Post Vitest scenario results to PR");
    const reportEnv = asRecord(report?.env);
    if (reportEnv.JOBS !== "${{ inputs.jobs }}") {
      errors.push("report-to-pr step must pass jobs through JOBS env");
    }
    if (reportEnv.JOB_PR_NUMBER !== "${{ inputs.pr_number }}") {
      errors.push("report-to-pr step must pass pr_number through JOB_PR_NUMBER env");
    }
    if (reportEnv.JOB_SCENARIOS !== "${{ inputs.scenarios }}") {
      errors.push("report-to-pr step must pass scenarios through JOB_SCENARIOS env");
    }
    const reportScript = stringValue(asRecord(report?.with).script ?? report?.run);
    if (!reportScript.includes("process.env.JOBS")) {
      errors.push("step 'Post Vitest scenario results to PR' run script must include process.env.JOBS");
    }
    if (!reportScript.includes("jobsValidationPassed")) {
      errors.push("step 'Post Vitest scenario results to PR' run script must check validate-jobs before echoing jobs");
    }
    if (!reportScript.includes("selector rejected by validate-jobs")) {
      errors.push("step 'Post Vitest scenario results to PR' run script must omit rejected job selectors");
    }
    if (!reportScript.includes("**Requested jobs:**")) {
      errors.push("step 'Post Vitest scenario results to PR' run script must include **Requested jobs:**");
    }
    for (const forbidden of ["toJSON(inputs.pr_number)", "toJSON(inputs.scenarios)"]) {
      if (reportScript.includes(forbidden)) {
        errors.push(
          `step 'Post Vitest scenario results to PR' run script must not include ${forbidden}`,
        );
      }
    }
  }

  return errors;
}
