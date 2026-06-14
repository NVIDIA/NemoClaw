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
export const FREE_STANDING_WORKFLOW_INVENTORY_SCRIPT =
  "tools/e2e-scenarios/free-standing-workflow-inventory.mts";

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  name?: string;
  run?: string;
  uses?: string;
  with?: WorkflowRecord;
};

export interface FreeStandingJobsInventory {
  allowedJobs: string[];
  freeStandingScenarios: string[];
  scenarioToJob: Map<string, string>;
}

const SELECTOR_PATTERN = /^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$/;
const SELECTOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const FREE_STANDING_JOB_MARKER = "FREE_STANDING_VITEST_JOB";
const FREE_STANDING_SCENARIO_MARKER = "FREE_STANDING_SCENARIO_ID";
const COMMON_SECRET_ENV_NAMES = [
  "NVIDIA_API_KEY",
  "DOCKERHUB_USERNAME",
  "DOCKERHUB_TOKEN",
  "GITHUB_TOKEN",
];
const FREE_STANDING_SELECTOR_SPECIAL_CASES = new Set([
  "hermes-e2e-vitest",
  "hermes-root-entrypoint-smoke-vitest",
]);

function asRecord(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function deriveFreeStandingJobsInventoryFromJobs(jobs: WorkflowRecord): {
  errors: string[];
  inventory: FreeStandingJobsInventory;
} {
  const errors: string[] = [];
  const allowedJobs: string[] = [];
  const freeStandingScenarios: string[] = [];
  const scenarioToJob = new Map<string, string>();

  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob);
    const env = asRecord(job.env);
    const hasJobMarker = Object.hasOwn(env, FREE_STANDING_JOB_MARKER);
    const hasScenarioMarker = Object.hasOwn(env, FREE_STANDING_SCENARIO_MARKER);
    if (!hasJobMarker && !hasScenarioMarker) continue;

    if (!SELECTOR_ID_PATTERN.test(jobId)) {
      errors.push(`free-standing workflow metadata contains invalid job id: ${jobId}`);
    }
    if (!hasJobMarker) {
      errors.push(
        `${jobId} job ${FREE_STANDING_SCENARIO_MARKER} requires ${FREE_STANDING_JOB_MARKER}`,
      );
      continue;
    }
    if (env[FREE_STANDING_JOB_MARKER] !== "1") {
      errors.push(`${jobId} job ${FREE_STANDING_JOB_MARKER} must be "1"`);
      continue;
    }

    allowedJobs.push(jobId);
    if (!hasScenarioMarker) continue;

    const scenario = env[FREE_STANDING_SCENARIO_MARKER];
    if (typeof scenario !== "string" || !SELECTOR_ID_PATTERN.test(scenario)) {
      errors.push(`${jobId} job ${FREE_STANDING_SCENARIO_MARKER} must be a selector id`);
      continue;
    }
    freeStandingScenarios.push(scenario);
    scenarioToJob.set(scenario, jobId);
  }

  if (allowedJobs.length === 0) {
    errors.push("free-standing workflow metadata must declare at least one job");
  }
  for (const duplicate of findDuplicates(allowedJobs)) {
    errors.push(`free-standing workflow metadata repeats job id: ${duplicate}`);
  }
  for (const duplicate of findDuplicates(freeStandingScenarios)) {
    errors.push(`free-standing workflow metadata repeats scenario id: ${duplicate}`);
  }

  return {
    errors,
    inventory: {
      allowedJobs,
      freeStandingScenarios,
      scenarioToJob,
    },
  };
}

function readWorkflowRecord(workflowPath: string): WorkflowRecord {
  return asRecord(YAML.parse(readFileSync(workflowPath, "utf-8")));
}

export function validateFreeStandingWorkflowInventory(
  workflowPath = DEFAULT_VITEST_WORKFLOW_PATH,
): string[] {
  const workflow = readWorkflowRecord(workflowPath);
  return deriveFreeStandingJobsInventoryFromJobs(asRecord(workflow.jobs)).errors;
}

export function readFreeStandingJobsInventory(
  workflowPath = DEFAULT_VITEST_WORKFLOW_PATH,
): FreeStandingJobsInventory {
  const workflow = readWorkflowRecord(workflowPath);
  const { errors, inventory } = deriveFreeStandingJobsInventoryFromJobs(asRecord(workflow.jobs));
  if (errors.length > 0) {
    throw new Error(`Invalid free-standing workflow inventory:\n${errors.join("\n")}`);
  }
  return inventory;
}

export function formatFreeStandingJobsInventoryForShell(
  inventory: FreeStandingJobsInventory,
): string {
  const scenarioJobMappings = [...inventory.scenarioToJob].map(
    ([scenario, job]) => `${scenario}:${job}`,
  );
  return [
    `allowed_jobs=${inventory.allowedJobs.join(",")}`,
    `free_standing_scenarios_csv=${inventory.freeStandingScenarios.join(",")}`,
    `free_standing_scenario_jobs_csv=${scenarioJobMappings.join(",")}`,
    "",
  ].join("\n");
}

export interface WorkflowDispatchSelectorEvaluation {
  valid: boolean;
  errors: string[];
  selectedFreeStandingJobs: string[];
  registryScenarios: string[];
  liveScenariosRuns: boolean;
}

function asSteps(value: unknown): WorkflowStep[] {
  return Array.isArray(value)
    ? (value.filter((entry) => asRecord(entry) === entry) as WorkflowStep[])
    : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function splitSelector(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function evaluateE2eVitestWorkflowDispatchSelectors(input: {
  jobs?: string;
  scenarios?: string;
}): WorkflowDispatchSelectorEvaluation {
  const inventory = readFreeStandingJobsInventory();
  const freeStandingVitestJobIds = inventory.allowedJobs;
  const freeStandingVitestScenarioToJob = inventory.scenarioToJob;
  const jobs = input.jobs ?? "";
  const scenarios = input.scenarios ?? "";
  const errors: string[] = [];

  if (jobs && scenarios) {
    errors.push("Use either scenarios or jobs, not both");
  }
  if (scenarios && !SELECTOR_PATTERN.test(scenarios)) {
    errors.push("Invalid scenario input");
  }
  if (jobs && !SELECTOR_PATTERN.test(jobs)) {
    errors.push("Invalid jobs input");
  }
  if (jobs && SELECTOR_PATTERN.test(jobs)) {
    for (const job of splitSelector(jobs)) {
      if (!freeStandingVitestJobIds.includes(job)) {
        errors.push(`Unknown free-standing Vitest job: ${job}`);
      }
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      selectedFreeStandingJobs: [],
      registryScenarios: [],
      liveScenariosRuns: false,
    };
  }

  if (!jobs && !scenarios) {
    return {
      valid: true,
      errors: [],
      selectedFreeStandingJobs: [...freeStandingVitestJobIds].sort(),
      registryScenarios: [],
      liveScenariosRuns: true,
    };
  }

  if (jobs) {
    return {
      valid: true,
      errors: [],
      selectedFreeStandingJobs: splitSelector(jobs).sort(),
      registryScenarios: [],
      liveScenariosRuns: false,
    };
  }

  const selectedFreeStandingJobs = new Set<string>();
  const registryScenarios: string[] = [];
  for (const scenario of splitSelector(scenarios)) {
    const job = freeStandingVitestScenarioToJob.get(scenario);
    if (job) selectedFreeStandingJobs.add(job);
    else registryScenarios.push(scenario);
  }

  return {
    valid: true,
    errors: [],
    selectedFreeStandingJobs: [...selectedFreeStandingJobs].sort(),
    registryScenarios,
    liveScenariosRuns: registryScenarios.length > 0,
  };
}

function namedStep(steps: readonly WorkflowStep[], name: string): WorkflowStep | undefined {
  return steps.find((step) => step.name === name);
}

function requireInput(errors: string[], inputs: WorkflowRecord, name: string): void {
  if (!Object.hasOwn(inputs, name)) errors.push(`workflow_dispatch missing input: ${name}`);
}

function requireStep(
  errors: string[],
  steps: readonly WorkflowStep[],
  name: string,
): WorkflowStep | undefined {
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

function requireRunContains(
  errors: string[],
  step: WorkflowStep | undefined,
  expected: string,
): void {
  if (!step) return;
  if (!stringValue(step.run).includes(expected)) {
    errors.push(`step '${step.name ?? "<unnamed>"}' run script must include ${expected}`);
  }
}

function requireRunDoesNotContain(
  errors: string[],
  step: WorkflowStep | undefined,
  forbidden: string,
): void {
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
  if (Object.keys(workflowDispatch).length === 0)
    errors.push("workflow must support workflow_dispatch");
  return workflowDispatch;
}

function rejectAutomaticTriggers(errors: string[], triggers: WorkflowRecord): void {
  for (const unsafe of ["push", "pull_request", "pull_request_target", "schedule"]) {
    if (Object.hasOwn(triggers, unsafe)) errors.push(`workflow must not run on ${unsafe}`);
  }
}

function requireFullShaAction(
  errors: string[],
  step: WorkflowStep | undefined,
  description: string,
): void {
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

function freeStandingJobIf(jobName: string, scenarioName?: string): string {
  const scenarioSelector = scenarioName
    ? ` || contains(format(',{0},', inputs.scenarios), ',${scenarioName},')`
    : "";
  return `\${{ (inputs.jobs == '' && inputs.scenarios == '') || contains(format(',{0},', inputs.jobs), ',${jobName},')${scenarioSelector} }}`;
}

function validateFreeStandingJobSelector(
  errors: string[],
  jobs: WorkflowRecord,
  jobName: string,
  scenarioName?: string,
): void {
  const job = asRecord(jobs[jobName]);
  if (job.needs !== "generate-matrix") {
    errors.push(`${jobName} job must depend on generate-matrix`);
  }
  if (job.if !== freeStandingJobIf(jobName, scenarioName)) {
    errors.push(`${jobName} job must use the shared jobs selector condition`);
  }
}

function validateFreeStandingInventoryBoundary(
  errors: string[],
  jobs: WorkflowRecord,
  inventory: FreeStandingJobsInventory,
): void {
  const scenarioByJob = new Map(
    [...inventory.scenarioToJob].map(([scenario, job]) => [job, scenario]),
  );

  for (const jobName of inventory.allowedJobs) {
    const job = asRecord(jobs[jobName]);
    if (Object.keys(job).length === 0) continue;

    if (!FREE_STANDING_SELECTOR_SPECIAL_CASES.has(jobName)) {
      validateFreeStandingJobSelector(errors, jobs, jobName, scenarioByJob.get(jobName));
    }

    const jobEnv = asRecord(job.env);
    for (const secret of COMMON_SECRET_ENV_NAMES) {
      requireEnvDoesNotExposeSecret(errors, `${jobName} job`, jobEnv, secret);
    }

    const steps = asSteps(job.steps);
    requireNoDispatchInputInterpolation(errors, steps);
    for (const step of steps) {
      if (step.uses) {
        requireFullShaAction(errors, step, `${jobName} step '${step.name ?? step.uses}'`);
      }
      if (/\$\{\{\s*secrets\./.test(stringValue(step.run))) {
        errors.push(
          `${jobName} step '${step.name ?? step.uses ?? "<unnamed>"}' run script must not interpolate secrets directly`,
        );
      }
    }
  }
}

function validateFreeStandingInventoryCoverage(
  errors: string[],
  jobs: WorkflowRecord,
  reportNeeds: readonly unknown[],
  inventory: FreeStandingJobsInventory,
): void {
  for (const jobId of inventory.allowedJobs) {
    if (!Object.hasOwn(jobs, jobId)) {
      errors.push(`free-standing inventory job missing workflow job: ${jobId}`);
    }
    if (!reportNeeds.includes(jobId)) {
      errors.push(`report-to-pr job must wait for ${jobId}`);
    }
  }
  for (const [scenario, jobId] of inventory.scenarioToJob) {
    if (!inventory.allowedJobs.includes(jobId)) {
      errors.push(`free-standing inventory maps ${scenario} to unknown job ${jobId}`);
      continue;
    }
    const job = asRecord(jobs[jobId]);
    if (Object.keys(job).length === 0) continue;
    const jobIf = stringValue(job.if);
    const mappingIsRepresented =
      jobIf.includes(`,${scenario},`) ||
      (jobId === "hermes-e2e-vitest" &&
        jobIf.includes("needs.generate-matrix.outputs.hermes_selected"));
    if (!mappingIsRepresented) {
      errors.push(
        `free-standing inventory mapping ${scenario}:${jobId} must match the workflow job selector`,
      );
    }
  }
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
  validateFreeStandingJobSelector(errors, jobs, jobName, "openshell-version-pin");

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("openshell-version-pin-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/vitest/openshell-version-pin"
  ) {
    errors.push(
      "openshell-version-pin-vitest job must write artifacts under e2e-artifacts/vitest/openshell-version-pin",
    );
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "openshell-version-pin-vitest job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    requireEnvDoesNotExposeSecret(
      errors,
      `openshell-version-pin-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`,
      asRecord(step.env),
      "NVIDIA_INFERENCE_API_KEY",
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
    errors.push(
      "openshell-version-pin-vitest artifact upload must set include-hidden-files: false",
    );
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push(
      "openshell-version-pin-vitest artifact upload must ignore missing fixture artifacts",
    );
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("openshell-version-pin-vitest artifact upload retention-days must be 14");
  }
}

function validateSkillAgentVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "skill-agent-vitest";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing skill-agent-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("skill-agent-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "skill-agent");

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("skill-agent-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/vitest/skill-agent") {
    errors.push(
      "skill-agent-vitest job must write artifacts under e2e-artifacts/vitest/skill-agent",
    );
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push("skill-agent-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "skill-agent-vitest job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Run skill-agent live test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `skill-agent-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("skill-agent-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "skill-agent-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("skill-agent-vitest checkout step must set persist-credentials=false");
  }

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("skill-agent-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "skill-agent-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell CLI");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");

  const runVitest = requireJobStep(errors, jobName, steps, "Run skill-agent live test");
  const runEnv = asRecord(runVitest?.env);
  if (runEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("skill-agent-vitest run step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(
    errors,
    runVitest,
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"',
  );
  requireRunContains(errors, runVitest, 'OPENSHELL_BIN="$(command -v openshell)"');
  requireRunContains(errors, runVitest, "export OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/skill-agent.test.ts");

  const upload = requireJobStep(errors, jobName, steps, "Upload skill-agent artifacts");
  requireFullShaAction(errors, upload, "skill-agent-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-skill-agent") {
    errors.push("skill-agent-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  for (const expected of [
    "e2e-artifacts/vitest/skill-agent/*/artifact-summary.json",
    "e2e-artifacts/vitest/skill-agent/*/cleanup.json",
    "e2e-artifacts/vitest/skill-agent/*/cleanup-skill-agent-summary.json",
    "e2e-artifacts/vitest/skill-agent/*/scenario.json",
    "e2e-artifacts/vitest/skill-agent/*/scenario-result.json",
    "e2e-artifacts/vitest/skill-agent/*/shell/*.result.json",
    "e2e-artifacts/vitest/skill-agent/*/shell/*.stdout.txt",
    "e2e-artifacts/vitest/skill-agent/*/shell/*.stderr.txt",
  ]) {
    requireUploadPathContains(errors, uploadPath, expected);
  }
  for (const line of uploadPath.split("\n")) {
    if (line.trim() === "e2e-artifacts/vitest/skill-agent/") {
      errors.push(
        "skill-agent-vitest artifact upload path must not list the whole skill-agent artifact directory",
      );
    }
  }
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("skill-agent-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("skill-agent-vitest artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("skill-agent-vitest artifact upload retention-days must be 14");
  }
}

function validateNetworkPolicyVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "network-policy-vitest";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing network-policy-vitest job");
    return;
  }
  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("network-policy-vitest job must run on ubuntu-latest");
  }
  if (job.needs !== "generate-matrix") {
    errors.push("network-policy-vitest job must depend on generate-matrix");
  }
  if (job.if !== freeStandingJobIf(jobName, "network-policy")) {
    errors.push(
      "network-policy-vitest job must map scenarios=network-policy to the network-policy job",
    );
  }

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("network-policy-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/vitest/network-policy") {
    errors.push(
      "network-policy-vitest job must write artifacts under e2e-artifacts/vitest/network-policy",
    );
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push("network-policy-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("network-policy-vitest job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  for (const secret of [
    "NVIDIA_INFERENCE_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(errors, "network-policy-vitest job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = step.name ?? step.uses ?? "<unnamed>";
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run network-policy live test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `network-policy-vitest step '${stepName}'`,
        stepEnv,
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(
        errors,
        `network-policy-vitest step '${stepName}'`,
        stepEnv,
        "DOCKERHUB_USERNAME",
      );
      requireEnvDoesNotExposeSecret(
        errors,
        `network-policy-vitest step '${stepName}'`,
        stepEnv,
        "DOCKERHUB_TOKEN",
      );
    }
    requireEnvDoesNotExposeSecret(
      errors,
      `network-policy-vitest step '${stepName}'`,
      stepEnv,
      "GITHUB_TOKEN",
    );
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("network-policy-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "network-policy-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("network-policy-vitest checkout step must set persist-credentials=false");
  }

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("network-policy-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "network-policy-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  if (namedStep(steps, "Authenticate to Docker Hub")) {
    errors.push("network-policy-vitest must not include unused Docker Hub authentication");
  }

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");
  requireRunContains(errors, installOpenShell, "env -u DOCKER_CONFIG");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_USERNAME");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_TOKEN");
  requireRunContains(errors, installOpenShell, "-u NVIDIA_INFERENCE_API_KEY");
  requireRunContains(errors, installOpenShell, "-u GITHUB_TOKEN");

  const runVitest = requireJobStep(errors, jobName, steps, "Run network-policy live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push(
      "network-policy-vitest Vitest step must receive NVIDIA_INFERENCE_API_KEY from secrets",
    );
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/network-policy.test.ts");

  const upload = requireJobStep(errors, jobName, steps, "Upload network-policy artifacts");
  requireFullShaAction(errors, upload, "network-policy-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-network-policy") {
    errors.push("network-policy-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/network-policy/");
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("network-policy-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("network-policy-vitest artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("network-policy-vitest artifact upload retention-days must be 14");
  }
}

function validateCommonEgressAgentVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "common-egress-agent-vitest";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing common-egress-agent-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("common-egress-agent-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "common-egress-agent");
  if (job["timeout-minutes"] !== 120) {
    errors.push("common-egress-agent-vitest job must keep the legacy 120 minute timeout");
  }

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("common-egress-agent-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/vitest/common-egress-agent"
  ) {
    errors.push(
      "common-egress-agent-vitest job must write artifacts under e2e-artifacts/vitest/common-egress-agent",
    );
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push("common-egress-agent-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.NEMOCLAW_NON_INTERACTIVE !== "1") {
    errors.push("common-egress-agent-vitest job must set NEMOCLAW_NON_INTERACTIVE=1");
  }
  if (jobEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    errors.push("common-egress-agent-vitest job must set NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
  }
  if (jobEnv.NEMOCLAW_RECREATE_SANDBOX !== "1") {
    errors.push("common-egress-agent-vitest job must set NEMOCLAW_RECREATE_SANDBOX=1");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("common-egress-agent-vitest job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  for (const secret of [
    "NVIDIA_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(errors, "common-egress-agent-vitest job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = step.name ?? step.uses ?? "<unnamed>";
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run common-egress agent live test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `common-egress-agent-vitest step '${stepName}'`,
        stepEnv,
        "NVIDIA_API_KEY",
      );
    }
    for (const secret of ["DOCKERHUB_USERNAME", "DOCKERHUB_TOKEN", "GITHUB_TOKEN"]) {
      requireEnvDoesNotExposeSecret(
        errors,
        `common-egress-agent-vitest step '${stepName}'`,
        stepEnv,
        secret,
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("common-egress-agent-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "common-egress-agent-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("common-egress-agent-vitest checkout step must set persist-credentials=false");
  }

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("common-egress-agent-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "common-egress-agent-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");
  requireRunContains(errors, installOpenShell, "env -u DOCKER_CONFIG");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_USERNAME");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_TOKEN");
  requireRunContains(errors, installOpenShell, "-u NVIDIA_API_KEY");
  requireRunContains(errors, installOpenShell, "-u GITHUB_TOKEN");

  const runVitest = requireJobStep(errors, jobName, steps, "Run common-egress agent live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_API_KEY !== "${{ secrets.NVIDIA_API_KEY }}") {
    errors.push("common-egress-agent-vitest step must receive NVIDIA_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/common-egress-agent.test.ts");

  const upload = requireJobStep(errors, jobName, steps, "Upload common-egress agent artifacts");
  requireFullShaAction(errors, upload, "common-egress-agent-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-common-egress-agent") {
    errors.push("common-egress-agent-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/common-egress-agent/");
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("common-egress-agent-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("common-egress-agent-vitest artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("common-egress-agent-vitest artifact upload retention-days must be 14");
  }
}

function validateShieldsConfigVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "shields-config-vitest";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing shields-config-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("shields-config-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "shields-config");
  if (job["timeout-minutes"] !== 45) {
    errors.push("shields-config-vitest job must keep the legacy 45 minute timeout");
  }
  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("shields-config-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/vitest/shields-config") {
    errors.push(
      "shields-config-vitest job must write artifacts under e2e-artifacts/vitest/shields-config",
    );
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("shields-config-vitest job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  if (jobEnv.NEMOCLAW_NON_INTERACTIVE !== "1") {
    errors.push("shields-config-vitest job must set NEMOCLAW_NON_INTERACTIVE=1");
  }
  if (jobEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    errors.push("shields-config-vitest job must set NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-shields") {
    errors.push("shields-config-vitest job must set NEMOCLAW_SANDBOX_NAME=e2e-shields");
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "shields-config-vitest job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );
  requireEnvDoesNotExposeSecret(errors, "shields-config-vitest job", jobEnv, "DOCKERHUB_USERNAME");
  requireEnvDoesNotExposeSecret(errors, "shields-config-vitest job", jobEnv, "DOCKERHUB_TOKEN");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = step.name ?? step.uses ?? "<unnamed>";
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run shields-config live test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `shields-config-vitest step '${stepName}'`,
        stepEnv,
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(
        errors,
        `shields-config-vitest step '${stepName}'`,
        stepEnv,
        "DOCKERHUB_USERNAME",
      );
      requireEnvDoesNotExposeSecret(
        errors,
        `shields-config-vitest step '${stepName}'`,
        stepEnv,
        "DOCKERHUB_TOKEN",
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("shields-config-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "shields-config-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("shields-config-vitest checkout step must set persist-credentials=false");
  }

  const dockerHubAuth = requireJobStep(errors, jobName, steps, "Authenticate to Docker Hub");
  const dockerHubEnv = asRecord(dockerHubAuth?.env);
  if (dockerHubEnv.DOCKERHUB_USERNAME !== "${{ secrets.DOCKERHUB_USERNAME }}") {
    errors.push(
      "shields-config-vitest Docker Hub auth must receive DOCKERHUB_USERNAME from secrets",
    );
  }
  if (dockerHubEnv.DOCKERHUB_TOKEN !== "${{ secrets.DOCKERHUB_TOKEN }}") {
    errors.push("shields-config-vitest Docker Hub auth must receive DOCKERHUB_TOKEN from secrets");
  }
  requireRunContains(errors, dockerHubAuth, "docker login docker.io");

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("shields-config-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "shields-config-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const runVitest = requireJobStep(errors, jobName, steps, "Run shields-config live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("shields-config-vitest step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/shields-config.test.ts");

  const upload = requireJobStep(errors, jobName, steps, "Upload shields-config artifacts");
  requireFullShaAction(errors, upload, "shields-config-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-shields-config") {
    errors.push("shields-config-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/shields-config/");
  requireUploadPathContains(errors, uploadPath, "/tmp/nemoclaw-e2e-shields-install.log");
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("shields-config-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("shields-config-vitest artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("shields-config-vitest artifact upload retention-days must be 14");
  }
}

function validateRebuildOpenClawVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "rebuild-openclaw-vitest";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing rebuild-openclaw-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("rebuild-openclaw-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "rebuild-openclaw");
  if (job["timeout-minutes"] !== 130) {
    errors.push("rebuild-openclaw-vitest job must keep the legacy 130 minute timeout");
  }
  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("rebuild-openclaw-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/vitest/rebuild-openclaw") {
    errors.push(
      "rebuild-openclaw-vitest job must write artifacts under e2e-artifacts/vitest/rebuild-openclaw",
    );
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push("rebuild-openclaw-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "rebuild-openclaw-vitest job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Run OpenClaw rebuild live test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `rebuild-openclaw-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("rebuild-openclaw-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "rebuild-openclaw-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("rebuild-openclaw-vitest checkout step must set persist-credentials=false");
  }

  const dockerHubAuth = requireJobStep(errors, jobName, steps, "Authenticate to Docker Hub");
  const dockerHubEnv = asRecord(dockerHubAuth?.env);
  if (dockerHubEnv.DOCKERHUB_USERNAME !== "${{ secrets.DOCKERHUB_USERNAME }}") {
    errors.push(
      "rebuild-openclaw-vitest Docker Hub auth must receive DOCKERHUB_USERNAME from secrets",
    );
  }
  if (dockerHubEnv.DOCKERHUB_TOKEN !== "${{ secrets.DOCKERHUB_TOKEN }}") {
    errors.push(
      "rebuild-openclaw-vitest Docker Hub auth must receive DOCKERHUB_TOKEN from secrets",
    );
  }
  requireRunContains(errors, dockerHubAuth, "docker login docker.io");

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("rebuild-openclaw-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "rebuild-openclaw-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell");
  requireEnvDoesNotExposeSecret(
    errors,
    "rebuild-openclaw-vitest step 'Install OpenShell'",
    asRecord(installOpenShell?.env),
    "GITHUB_TOKEN",
  );
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");
  requireRunContains(errors, installOpenShell, "env -u DOCKER_CONFIG");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_USERNAME");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_TOKEN");
  requireRunContains(errors, installOpenShell, "-u NVIDIA_INFERENCE_API_KEY");
  requireRunContains(errors, installOpenShell, "-u GITHUB_TOKEN");

  const runVitest = requireJobStep(errors, jobName, steps, "Run OpenClaw rebuild live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("rebuild-openclaw-vitest step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/rebuild-openclaw.test.ts");

  const upload = requireJobStep(errors, jobName, steps, "Upload OpenClaw rebuild artifacts");
  requireFullShaAction(errors, upload, "rebuild-openclaw-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-rebuild-openclaw") {
    errors.push("rebuild-openclaw-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/rebuild-openclaw/");
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("rebuild-openclaw-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("rebuild-openclaw-vitest artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("rebuild-openclaw-vitest artifact upload retention-days must be 14");
  }
}

function validateSandboxRebuildVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "sandbox-rebuild-vitest";
  const scenarioName = "sandbox-rebuild";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing sandbox-rebuild-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("sandbox-rebuild-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, scenarioName);
  if (job["timeout-minutes"] !== 90) {
    errors.push("sandbox-rebuild-vitest job must keep the legacy 90 minute timeout");
  }
  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("sandbox-rebuild-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/vitest/sandbox-rebuild") {
    errors.push(
      "sandbox-rebuild-vitest job must write artifacts under e2e-artifacts/vitest/sandbox-rebuild",
    );
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("sandbox-rebuild-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("sandbox-rebuild-vitest job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  for (const secret of [
    "NVIDIA_INFERENCE_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(errors, "sandbox-rebuild-vitest job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `sandbox-rebuild-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run sandbox rebuild live test") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
    }
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "GITHUB_TOKEN");
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("sandbox-rebuild-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "sandbox-rebuild-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("sandbox-rebuild-vitest checkout step must set persist-credentials=false");
  }

  const dockerHubAuth = requireJobStep(errors, jobName, steps, "Authenticate to Docker Hub");
  const dockerHubEnv = asRecord(dockerHubAuth?.env);
  if (dockerHubEnv.DOCKERHUB_USERNAME !== "${{ secrets.DOCKERHUB_USERNAME }}") {
    errors.push(
      "sandbox-rebuild-vitest Docker Hub auth must receive DOCKERHUB_USERNAME from secrets",
    );
  }
  if (dockerHubEnv.DOCKERHUB_TOKEN !== "${{ secrets.DOCKERHUB_TOKEN }}") {
    errors.push("sandbox-rebuild-vitest Docker Hub auth must receive DOCKERHUB_TOKEN from secrets");
  }
  requireRunContains(errors, dockerHubAuth, "docker login docker.io");
  requireRunContains(errors, dockerHubAuth, "continuing with anonymous pulls");

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("sandbox-rebuild-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "sandbox-rebuild-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");
  requireRunContains(errors, installOpenShell, "env -u DOCKER_CONFIG");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_USERNAME");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_TOKEN");
  requireRunContains(errors, installOpenShell, "-u NVIDIA_INFERENCE_API_KEY");
  requireRunContains(errors, installOpenShell, "-u GITHUB_TOKEN");

  const runVitest = requireJobStep(errors, jobName, steps, "Run sandbox rebuild live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("sandbox-rebuild-vitest step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/sandbox-rebuild.test.ts");

  const upload = requireJobStep(errors, jobName, steps, "Upload sandbox rebuild artifacts");
  requireFullShaAction(errors, upload, "sandbox-rebuild-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-sandbox-rebuild") {
    errors.push("sandbox-rebuild-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/sandbox-rebuild/");
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("sandbox-rebuild-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("sandbox-rebuild-vitest artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("sandbox-rebuild-vitest artifact upload retention-days must be 14");
  }
}

function validateStateBackupRestoreVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "state-backup-restore-vitest";
  const scenarioName = "state-backup-restore";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing state-backup-restore-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("state-backup-restore-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, scenarioName);
  if (job["timeout-minutes"] !== 60) {
    errors.push("state-backup-restore-vitest job must keep the legacy 60 minute timeout");
  }
  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("state-backup-restore-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/vitest/state-backup-restore"
  ) {
    errors.push(
      "state-backup-restore-vitest job must write artifacts under e2e-artifacts/vitest/state-backup-restore",
    );
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("state-backup-restore-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("state-backup-restore-vitest job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  if (jobEnv.NEMOCLAW_NON_INTERACTIVE !== "1") {
    errors.push("state-backup-restore-vitest job must set NEMOCLAW_NON_INTERACTIVE=1");
  }
  if (jobEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    errors.push("state-backup-restore-vitest job must set NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-state-backup") {
    errors.push("state-backup-restore-vitest job must set NEMOCLAW_SANDBOX_NAME=e2e-state-backup");
  }
  for (const secret of [
    "NVIDIA_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(errors, "state-backup-restore-vitest job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `state-backup-restore-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run state backup restore live test") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_API_KEY");
    }
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "GITHUB_TOKEN");
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("state-backup-restore-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "state-backup-restore-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("state-backup-restore-vitest checkout step must set persist-credentials=false");
  }

  const dockerHubAuth = requireJobStep(errors, jobName, steps, "Authenticate to Docker Hub");
  const dockerHubEnv = asRecord(dockerHubAuth?.env);
  if (dockerHubEnv.DOCKERHUB_USERNAME !== "${{ secrets.DOCKERHUB_USERNAME }}") {
    errors.push(
      "state-backup-restore-vitest Docker Hub auth must receive DOCKERHUB_USERNAME from secrets",
    );
  }
  if (dockerHubEnv.DOCKERHUB_TOKEN !== "${{ secrets.DOCKERHUB_TOKEN }}") {
    errors.push(
      "state-backup-restore-vitest Docker Hub auth must receive DOCKERHUB_TOKEN from secrets",
    );
  }
  requireRunContains(errors, dockerHubAuth, "docker login docker.io");
  requireRunContains(errors, dockerHubAuth, "continuing with anonymous pulls");

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("state-backup-restore-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "state-backup-restore-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");
  requireRunContains(errors, installOpenShell, "env -u DOCKER_CONFIG");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_USERNAME");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_TOKEN");
  requireRunContains(errors, installOpenShell, "-u NVIDIA_API_KEY");
  requireRunContains(errors, installOpenShell, "-u GITHUB_TOKEN");

  const runVitest = requireJobStep(errors, jobName, steps, "Run state backup restore live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_API_KEY !== "${{ secrets.NVIDIA_API_KEY }}") {
    errors.push("state-backup-restore-vitest step must receive NVIDIA_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/state-backup-restore.test.ts");

  const upload = requireJobStep(errors, jobName, steps, "Upload state backup restore artifacts");
  requireFullShaAction(errors, upload, "state-backup-restore-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-state-backup-restore") {
    errors.push("state-backup-restore-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/state-backup-restore/");
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("state-backup-restore-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push(
      "state-backup-restore-vitest artifact upload must ignore missing fixture artifacts",
    );
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("state-backup-restore-vitest artifact upload retention-days must be 14");
  }
}

function validateTokenRotationVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "token-rotation-vitest";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing token-rotation-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("token-rotation-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "token-rotation");
  if (job["timeout-minutes"] !== 45) {
    errors.push("token-rotation-vitest job must keep the legacy 45 minute timeout");
  }
  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("token-rotation-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/vitest/token-rotation") {
    errors.push(
      "token-rotation-vitest job must write artifacts under e2e-artifacts/vitest/token-rotation",
    );
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push("token-rotation-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "token-rotation-vitest job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Run token rotation live test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `token-rotation-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("token-rotation-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "token-rotation-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("token-rotation-vitest checkout step must set persist-credentials=false");
  }

  const dockerHubAuth = requireJobStep(errors, jobName, steps, "Authenticate to Docker Hub");
  const dockerHubEnv = asRecord(dockerHubAuth?.env);
  if (dockerHubEnv.DOCKERHUB_USERNAME !== "${{ secrets.DOCKERHUB_USERNAME }}") {
    errors.push(
      "token-rotation-vitest Docker Hub auth must receive DOCKERHUB_USERNAME from secrets",
    );
  }
  if (dockerHubEnv.DOCKERHUB_TOKEN !== "${{ secrets.DOCKERHUB_TOKEN }}") {
    errors.push("token-rotation-vitest Docker Hub auth must receive DOCKERHUB_TOKEN from secrets");
  }
  requireRunContains(errors, dockerHubAuth, "docker login docker.io");

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("token-rotation-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "token-rotation-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const runVitest = requireJobStep(errors, jobName, steps, "Run token rotation live test");
  const runVitestEnv = asRecord(runVitest?.env);
  requireEnvDoesNotExposeSecret(
    errors,
    "token-rotation-vitest step",
    runVitestEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );
  if (runVitestEnv.GITHUB_TOKEN !== "${{ github.token }}") {
    errors.push("token-rotation-vitest step must receive GITHUB_TOKEN from github.token");
  }
  for (const tokenName of [
    "TELEGRAM_BOT_TOKEN_A",
    "TELEGRAM_BOT_TOKEN_B",
    "DISCORD_BOT_TOKEN_A",
    "DISCORD_BOT_TOKEN_B",
    "SLACK_BOT_TOKEN_A",
    "SLACK_BOT_TOKEN_B",
    "SLACK_APP_TOKEN_A",
    "SLACK_APP_TOKEN_B",
  ]) {
    const tokenValue = stringValue(runVitestEnv[tokenName]);
    if (
      tokenValue.length === 0 ||
      tokenValue.includes("${{") ||
      !/^(test-fake-token-|dc-|xoxb-fake-|xapp-fake-)/.test(tokenValue)
    ) {
      errors.push(`token-rotation-vitest step must set ${tokenName}`);
    }
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/token-rotation.test.ts");

  const upload = requireJobStep(errors, jobName, steps, "Upload token rotation artifacts");
  requireFullShaAction(errors, upload, "token-rotation-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-token-rotation") {
    errors.push("token-rotation-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/token-rotation/");
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("token-rotation-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("token-rotation-vitest artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("token-rotation-vitest artifact upload retention-days must be 14");
  }
}

function validateMessagingCompatibleEndpointVitestJob(
  errors: string[],
  jobs: WorkflowRecord,
): void {
  const jobName = "messaging-compatible-endpoint-vitest";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing messaging-compatible-endpoint-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("messaging-compatible-endpoint-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "messaging-compatible-endpoint");
  if (job["timeout-minutes"] !== 45) {
    errors.push("messaging-compatible-endpoint-vitest job must keep the legacy 45 minute timeout");
  }

  const jobEnv = asRecord(job.env);
  if (
    jobEnv.E2E_ARTIFACT_DIR !==
    "${{ github.workspace }}/e2e-artifacts/vitest/messaging-compatible-endpoint"
  ) {
    errors.push(
      "messaging-compatible-endpoint-vitest job must write artifacts under e2e-artifacts/vitest/messaging-compatible-endpoint",
    );
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push(
      "messaging-compatible-endpoint-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI",
    );
  }
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("messaging-compatible-endpoint-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-msg-compat") {
    errors.push("messaging-compatible-endpoint-vitest job must pin the legacy sandbox name");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("messaging-compatible-endpoint-vitest job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "messaging-compatible-endpoint-vitest job",
    jobEnv,
    "NVIDIA_API_KEY",
  );
  requireEnvDoesNotExposeSecret(
    errors,
    "messaging-compatible-endpoint-vitest job",
    jobEnv,
    "DOCKERHUB_USERNAME",
  );
  requireEnvDoesNotExposeSecret(
    errors,
    "messaging-compatible-endpoint-vitest job",
    jobEnv,
    "DOCKERHUB_TOKEN",
  );

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = step.name ?? step.uses ?? "<unnamed>";
    const stepEnv = asRecord(step.env);
    requireEnvDoesNotExposeSecret(
      errors,
      `messaging-compatible-endpoint-vitest step '${stepName}'`,
      stepEnv,
      "NVIDIA_API_KEY",
    );
    requireEnvDoesNotExposeSecret(
      errors,
      `messaging-compatible-endpoint-vitest step '${stepName}'`,
      stepEnv,
      "DOCKERHUB_USERNAME",
    );
    requireEnvDoesNotExposeSecret(
      errors,
      `messaging-compatible-endpoint-vitest step '${stepName}'`,
      stepEnv,
      "DOCKERHUB_TOKEN",
    );
    requireNoDockerHubAuthInRun(
      errors,
      `messaging-compatible-endpoint-vitest step '${stepName}'`,
      stringValue(step.run),
    );
  }

  if (namedStep(steps, "Authenticate to Docker Hub")) {
    errors.push(
      "messaging-compatible-endpoint-vitest must not authenticate to Docker Hub before branch-controlled test code runs",
    );
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("messaging-compatible-endpoint-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "messaging-compatible-endpoint-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push(
      "messaging-compatible-endpoint-vitest checkout step must set persist-credentials=false",
    );
  }

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("messaging-compatible-endpoint-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "messaging-compatible-endpoint-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const runVitest = requireJobStep(
    errors,
    jobName,
    steps,
    "Run messaging compatible endpoint live test",
  );
  const runVitestEnv = asRecord(runVitest?.env);
  requireEnvDoesNotExposeSecret(
    errors,
    "messaging-compatible-endpoint-vitest step",
    runVitestEnv,
    "NVIDIA_API_KEY",
  );
  if (runVitestEnv.NEMOCLAW_COMPAT_MOCK_API_KEY !== "fake-compatible-key-e2e") {
    errors.push(
      "messaging-compatible-endpoint-vitest step must set a fake compatible endpoint key",
    );
  }
  if (runVitestEnv.TELEGRAM_BOT_TOKEN !== "test-fake-telegram-token-e2e") {
    errors.push("messaging-compatible-endpoint-vitest step must set a fake Telegram token");
  }
  if (runVitestEnv.TELEGRAM_ALLOWED_IDS !== "123456789") {
    errors.push("messaging-compatible-endpoint-vitest step must set fake Telegram allowed ids");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(
    errors,
    runVitest,
    "test/e2e-scenario/live/messaging-compatible-endpoint.test.ts",
  );

  const upload = requireJobStep(
    errors,
    jobName,
    steps,
    "Upload messaging compatible endpoint artifacts",
  );
  requireFullShaAction(errors, upload, "messaging-compatible-endpoint-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-messaging-compatible-endpoint") {
    errors.push("messaging-compatible-endpoint-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/vitest/messaging-compatible-endpoint/",
  );
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push(
      "messaging-compatible-endpoint-vitest artifact upload must set include-hidden-files: false",
    );
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push(
      "messaging-compatible-endpoint-vitest artifact upload must ignore missing fixture artifacts",
    );
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("messaging-compatible-endpoint-vitest artifact upload retention-days must be 14");
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
  validateFreeStandingJobSelector(errors, jobs, jobName, "onboard-negative-paths");

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
  requireEnvDoesNotExposeSecret(
    errors,
    "onboard-negative-paths-vitest job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    requireEnvDoesNotExposeSecret(
      errors,
      `onboard-negative-paths-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`,
      asRecord(step.env),
      "NVIDIA_INFERENCE_API_KEY",
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
    errors.push(
      "onboard-negative-paths-vitest artifact upload must set include-hidden-files: false",
    );
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push(
      "onboard-negative-paths-vitest artifact upload must ignore missing fixture artifacts",
    );
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("onboard-negative-paths-vitest artifact upload retention-days must be 14");
  }
}

function validateCloudInferenceVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "cloud-inference-vitest";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing cloud-inference-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("cloud-inference-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "cloud-inference");
  if (job["timeout-minutes"] !== 50) {
    errors.push("cloud-inference-vitest job must keep the 50 minute timeout");
  }

  const jobEnv = asRecord(job.env);
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/vitest/cloud-inference") {
    errors.push(
      "cloud-inference-vitest job must write artifacts under e2e-artifacts/vitest/cloud-inference",
    );
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("cloud-inference-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("cloud-inference-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-cloud-inference") {
    errors.push("cloud-inference-vitest job must set NEMOCLAW_SANDBOX_NAME=e2e-cloud-inference");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("cloud-inference-vitest job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  requireEnvDoesNotExposeSecret(errors, "cloud-inference-vitest job", jobEnv, "NVIDIA_API_KEY");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Run cloud inference live test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `cloud-inference-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "NVIDIA_API_KEY",
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("cloud-inference-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "cloud-inference-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("cloud-inference-vitest checkout step must set persist-credentials=false");
  }

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("cloud-inference-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "cloud-inference-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const runVitest = requireJobStep(errors, jobName, steps, "Run cloud inference live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_API_KEY !== "${{ secrets.NVIDIA_API_KEY }}") {
    errors.push("cloud-inference-vitest run step must receive NVIDIA_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/cloud-inference.test.ts");

  const upload = requireJobStep(errors, jobName, steps, "Upload cloud inference artifacts");
  requireFullShaAction(errors, upload, "cloud-inference-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-cloud-inference") {
    errors.push("cloud-inference-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/cloud-inference/");
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("cloud-inference-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("cloud-inference-vitest artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("cloud-inference-vitest artifact upload retention-days must be 14");
  }
}

function requireNoDockerHubAuthInRun(errors: string[], owner: string, runScript: string): void {
  if (!runScript) return;
  const usesDockerLogin = /\bdocker\s+login\b/i.test(runScript);
  const referencesSecret = /\bsecrets\.[A-Za-z0-9_]+\b|\$\{\{\s*secrets\.[^}]+\}\}/.test(runScript);
  if (usesDockerLogin || referencesSecret) {
    errors.push(`${owner} run script must not use docker login or inline secret interpolation`);
  }
}

function validateDoubleOnboardVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "double-onboard-vitest";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing double-onboard-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("double-onboard-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "double-onboard");

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("double-onboard-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("double-onboard-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/vitest/double-onboard") {
    errors.push(
      "double-onboard-vitest job must write artifacts under e2e-artifacts/vitest/double-onboard",
    );
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "double-onboard-vitest job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );
  requireEnvDoesNotExposeSecret(errors, "double-onboard-vitest job", jobEnv, "DOCKERHUB_TOKEN");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(
        errors,
        `double-onboard-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "DOCKERHUB_TOKEN",
      );
    }
    requireEnvDoesNotExposeSecret(
      errors,
      `double-onboard-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`,
      asRecord(step.env),
      "NVIDIA_INFERENCE_API_KEY",
    );
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("double-onboard-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "double-onboard-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("double-onboard-vitest checkout step must set persist-credentials=false");
  }

  const dockerLogin = requireJobStep(errors, jobName, steps, "Authenticate to Docker Hub");
  const dockerLoginEnv = asRecord(dockerLogin?.env);
  if (dockerLoginEnv.DOCKERHUB_USERNAME !== "${{ secrets.DOCKERHUB_USERNAME }}") {
    errors.push(
      "double-onboard-vitest Docker login step must read DOCKERHUB_USERNAME from secrets",
    );
  }
  if (dockerLoginEnv.DOCKERHUB_TOKEN !== "${{ secrets.DOCKERHUB_TOKEN }}") {
    errors.push("double-onboard-vitest Docker login step must read DOCKERHUB_TOKEN from secrets");
  }
  requireRunContains(errors, dockerLogin, "docker login docker.io");
  requireRunContains(errors, dockerLogin, "continuing with anonymous pulls");

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("double-onboard-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "double-onboard-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const installTools = requireJobStep(errors, jobName, steps, "Install OpenShell CLI");
  requireRunContains(errors, installTools, "bash scripts/install-openshell.sh");

  const runVitest = requireJobStep(errors, jobName, steps, "Run double-onboard live Vitest test");
  requireRunContains(errors, runVitest, "OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/double-onboard.test.ts");

  const upload = requireJobStep(errors, jobName, steps, "Upload double-onboard Vitest artifacts");
  requireFullShaAction(errors, upload, "double-onboard-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-double-onboard") {
    errors.push("double-onboard-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/double-onboard/");
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("double-onboard-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("double-onboard-vitest artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("double-onboard-vitest artifact upload retention-days must be 14");
  }
}
function validateRuntimeOverridesVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "runtime-overrides-vitest";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing runtime-overrides-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("runtime-overrides-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "runtime-overrides");

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("runtime-overrides-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/vitest/runtime-overrides"
  ) {
    errors.push(
      "runtime-overrides-vitest job must write artifacts under e2e-artifacts/vitest/runtime-overrides",
    );
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "runtime-overrides-vitest job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );
  requireEnvDoesNotExposeSecret(
    errors,
    "runtime-overrides-vitest job",
    jobEnv,
    "DOCKERHUB_USERNAME",
  );
  requireEnvDoesNotExposeSecret(errors, "runtime-overrides-vitest job", jobEnv, "DOCKERHUB_TOKEN");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `runtime-overrides-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
    requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("runtime-overrides-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "runtime-overrides-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("runtime-overrides-vitest checkout step must set persist-credentials=false");
  }

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("runtime-overrides-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "runtime-overrides-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const runVitest = requireJobStep(errors, jobName, steps, "Run runtime overrides live test");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/runtime-overrides.test.ts");

  const upload = requireJobStep(errors, jobName, steps, "Upload runtime overrides artifacts");
  requireFullShaAction(errors, upload, "runtime-overrides-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-runtime-overrides") {
    errors.push("runtime-overrides-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/runtime-overrides/");
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("runtime-overrides-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("runtime-overrides-vitest artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("runtime-overrides-vitest artifact upload retention-days must be 14");
  }
}

function validateHermesE2EVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "hermes-e2e-vitest";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing hermes-e2e-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("hermes-e2e-vitest job must run on ubuntu-latest");
  }
  if (job.needs !== "generate-matrix") {
    errors.push("hermes-e2e-vitest job must depend on generate-matrix validation");
  }
  if (job.if !== "${{ needs.generate-matrix.outputs.hermes_selected == 'true' }}") {
    errors.push("hermes-e2e-vitest job must use validated hermes_selected output");
  }
  if (stringValue(job.if).includes("inputs.scenarios")) {
    errors.push("hermes-e2e-vitest job must not inspect raw workflow dispatch scenarios");
  }

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("hermes-e2e-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("hermes-e2e-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/vitest/hermes-e2e") {
    errors.push("hermes-e2e-vitest job must write artifacts under e2e-artifacts/vitest/hermes-e2e");
  }
  if (jobEnv.NEMOCLAW_AGENT !== "hermes") {
    errors.push("hermes-e2e-vitest job must set NEMOCLAW_AGENT=hermes");
  }
  if (jobEnv.NEMOCLAW_MODEL !== "minimaxai/minimax-m2.7") {
    errors.push("hermes-e2e-vitest job must pin the CI-safe Hermes model");
  }
  if (jobEnv.NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS !== "60") {
    errors.push("hermes-e2e-vitest job must give hosted endpoint validation a CI-safe timeout");
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "hermes-e2e-vitest job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Run Hermes live Vitest test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `hermes-e2e-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("hermes-e2e-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "hermes-e2e-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("hermes-e2e-vitest checkout step must set persist-credentials=false");
  }

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("hermes-e2e-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "hermes-e2e-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const runVitest = requireJobStep(errors, jobName, steps, "Run Hermes live Vitest test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("hermes-e2e-vitest Vitest step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/hermes-e2e.test.ts");
  requireRunDoesNotContain(errors, runVitest, "${{ inputs.");

  const upload = requireJobStep(errors, jobName, steps, "Upload Hermes live Vitest artifacts");
  requireFullShaAction(errors, upload, "hermes-e2e-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-hermes-e2e") {
    errors.push("hermes-e2e-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/hermes-e2e/");
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("hermes-e2e-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("hermes-e2e-vitest artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("hermes-e2e-vitest artifact upload retention-days must be 14");
  }
}

function validateHermesRootEntrypointSmokeVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "hermes-root-entrypoint-smoke-vitest";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing hermes-root-entrypoint-smoke-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("hermes-root-entrypoint-smoke-vitest job must run on ubuntu-latest");
  }
  if (job.needs !== "generate-matrix") {
    errors.push("hermes-root-entrypoint-smoke-vitest job must depend on generate-matrix");
  }
  const expectedIf =
    "${{ needs.generate-matrix.result == 'success' && ((inputs.jobs == '' && inputs.scenarios == '') || contains(format(',{0},', inputs.jobs), ',hermes-root-entrypoint-smoke-vitest,') || contains(format(',{0},', inputs.scenarios), ',hermes-root-entrypoint-smoke,')) }}";
  if (job.if !== expectedIf) {
    errors.push(
      "hermes-root-entrypoint-smoke-vitest job must gate on generate-matrix and the shared selector condition",
    );
  }
  if (job["timeout-minutes"] !== 45) {
    errors.push("hermes-root-entrypoint-smoke-vitest job must keep the 45 minute timeout");
  }

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("hermes-root-entrypoint-smoke-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !==
    "${{ github.workspace }}/e2e-artifacts/vitest/hermes-root-entrypoint-smoke"
  ) {
    errors.push(
      "hermes-root-entrypoint-smoke-vitest job must write artifacts under e2e-artifacts/vitest/hermes-root-entrypoint-smoke",
    );
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "hermes-root-entrypoint-smoke-vitest job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );
  requireEnvDoesNotExposeSecret(
    errors,
    "hermes-root-entrypoint-smoke-vitest job",
    jobEnv,
    "DOCKERHUB_USERNAME",
  );
  requireEnvDoesNotExposeSecret(
    errors,
    "hermes-root-entrypoint-smoke-vitest job",
    jobEnv,
    "DOCKERHUB_TOKEN",
  );

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = step.name ?? step.uses ?? "<unnamed>";
    const stepEnv = asRecord(step.env);
    requireEnvDoesNotExposeSecret(
      errors,
      `hermes-root-entrypoint-smoke-vitest step '${stepName}'`,
      stepEnv,
      "NVIDIA_INFERENCE_API_KEY",
    );
    requireEnvDoesNotExposeSecret(
      errors,
      `hermes-root-entrypoint-smoke-vitest step '${stepName}'`,
      stepEnv,
      "DOCKERHUB_USERNAME",
    );
    requireEnvDoesNotExposeSecret(
      errors,
      `hermes-root-entrypoint-smoke-vitest step '${stepName}'`,
      stepEnv,
      "DOCKERHUB_TOKEN",
    );
    requireNoDockerHubAuthInRun(
      errors,
      `hermes-root-entrypoint-smoke-vitest step '${stepName}'`,
      stringValue(step.run),
    );
  }

  if (namedStep(steps, "Authenticate to Docker Hub")) {
    errors.push(
      "hermes-root-entrypoint-smoke-vitest must not authenticate to Docker Hub before branch-controlled test code runs",
    );
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("hermes-root-entrypoint-smoke-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "hermes-root-entrypoint-smoke-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push(
      "hermes-root-entrypoint-smoke-vitest checkout step must set persist-credentials=false",
    );
  }

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("hermes-root-entrypoint-smoke-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "hermes-root-entrypoint-smoke-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const runVitest = requireJobStep(
    errors,
    jobName,
    steps,
    "Run Hermes root entrypoint smoke live test",
  );
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(
    errors,
    runVitest,
    "test/e2e-scenario/live/hermes-root-entrypoint-smoke.test.ts",
  );
  requireRunDoesNotContain(errors, runVitest, "${{ inputs.");

  const upload = requireJobStep(
    errors,
    jobName,
    steps,
    "Upload Hermes root entrypoint smoke artifacts",
  );
  requireFullShaAction(errors, upload, "hermes-root-entrypoint-smoke-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-hermes-root-entrypoint-smoke") {
    errors.push("hermes-root-entrypoint-smoke-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/vitest/hermes-root-entrypoint-smoke/",
  );
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push(
      "hermes-root-entrypoint-smoke-vitest artifact upload must set include-hidden-files: false",
    );
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push(
      "hermes-root-entrypoint-smoke-vitest artifact upload must ignore missing fixture artifacts",
    );
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("hermes-root-entrypoint-smoke-vitest artifact upload retention-days must be 14");
  }
}

function validateModelRouterProviderRoutedInferenceVitestJob(
  errors: string[],
  jobs: WorkflowRecord,
): void {
  const jobName = "model-router-provider-routed-inference-vitest";
  const scenarioName = "model-router-provider-routed-inference";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing model-router-provider-routed-inference-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("model-router-provider-routed-inference-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, scenarioName);

  const jobEnv = asRecord(job.env);
  if ("DOCKER_CONFIG" in jobEnv) {
    errors.push(
      "model-router-provider-routed-inference-vitest job must not set DOCKER_CONFIG at job level",
    );
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !==
    "${{ github.workspace }}/e2e-artifacts/vitest/model-router-provider-routed-inference"
  ) {
    errors.push(
      "model-router-provider-routed-inference-vitest job must write artifacts under e2e-artifacts/vitest/model-router-provider-routed-inference",
    );
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push(
      "model-router-provider-routed-inference-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI",
    );
  }
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push(
      "model-router-provider-routed-inference-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1",
    );
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push(
      "model-router-provider-routed-inference-vitest job must force OPENSHELL_GATEWAY=nemoclaw",
    );
  }
  for (const secret of [
    "NVIDIA_INFERENCE_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(
      errors,
      "model-router-provider-routed-inference-vitest job",
      jobEnv,
      secret,
    );
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `model-router-provider-routed-inference-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run Model Router provider-routed inference live test") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
    }
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "GITHUB_TOKEN");
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) {
    errors.push("model-router-provider-routed-inference-vitest job missing checkout step");
  }
  requireFullShaAction(errors, checkout, "model-router-provider-routed-inference-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push(
      "model-router-provider-routed-inference-vitest checkout step must set persist-credentials=false",
    );
  }

  const configureDockerAuth = requireJobStep(
    errors,
    jobName,
    steps,
    "Configure isolated Docker auth directory",
  );
  requireRunContains(
    errors,
    configureDockerAuth,
    'echo "DOCKER_CONFIG=${RUNNER_TEMP}/docker-config-model-router-provider-routed-inference" >> "$GITHUB_ENV"',
  );
  requireRunDoesNotContain(errors, configureDockerAuth, "${{ runner.temp }}");

  const dockerLogin = requireJobStep(errors, jobName, steps, "Authenticate to Docker Hub");
  const dockerLoginEnv = asRecord(dockerLogin?.env);
  if (dockerLoginEnv.DOCKERHUB_USERNAME !== "${{ secrets.DOCKERHUB_USERNAME }}") {
    errors.push(
      "model-router-provider-routed-inference-vitest Docker Hub auth must receive DOCKERHUB_USERNAME from secrets",
    );
  }
  if (dockerLoginEnv.DOCKERHUB_TOKEN !== "${{ secrets.DOCKERHUB_TOKEN }}") {
    errors.push(
      "model-router-provider-routed-inference-vitest Docker Hub auth must receive DOCKERHUB_TOKEN from secrets",
    );
  }
  requireRunContains(errors, dockerLogin, 'mkdir -p "${DOCKER_CONFIG}"');
  requireRunContains(errors, dockerLogin, 'chmod 700 "${DOCKER_CONFIG}"');
  requireRunContains(errors, dockerLogin, "docker login docker.io");
  requireRunContains(errors, dockerLogin, "--password-stdin");
  requireRunContains(errors, dockerLogin, "continuing with anonymous pulls");

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) {
    errors.push("model-router-provider-routed-inference-vitest job missing step: Set up Node");
  }
  requireFullShaAction(
    errors,
    setupNode,
    "model-router-provider-routed-inference-vitest setup-node",
  );

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const runVitest = requireJobStep(
    errors,
    jobName,
    steps,
    "Run Model Router provider-routed inference live test",
  );
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push(
      "model-router-provider-routed-inference-vitest Vitest step must receive NVIDIA_INFERENCE_API_KEY from secrets",
    );
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(
    errors,
    runVitest,
    "test/e2e-scenario/live/model-router-provider-routed-inference.test.ts",
  );

  const upload = requireJobStep(
    errors,
    jobName,
    steps,
    "Upload Model Router provider-routed inference artifacts",
  );
  requireFullShaAction(
    errors,
    upload,
    "model-router-provider-routed-inference-vitest upload-artifact",
  );
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-model-router-provider-routed-inference") {
    errors.push(
      "model-router-provider-routed-inference-vitest artifact upload name must be stable",
    );
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/vitest/model-router-provider-routed-inference/",
  );
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push(
      "model-router-provider-routed-inference-vitest artifact upload must set include-hidden-files: false",
    );
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push(
      "model-router-provider-routed-inference-vitest artifact upload must ignore missing fixture artifacts",
    );
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push(
      "model-router-provider-routed-inference-vitest artifact upload retention-days must be 14",
    );
  }

  const cleanup = requireJobStep(errors, jobName, steps, "Clean up Docker auth");
  if (cleanup?.if !== "always()") {
    errors.push(
      "model-router-provider-routed-inference-vitest Docker auth cleanup must always run",
    );
  }
  requireRunContains(errors, cleanup, "docker logout docker.io");
  requireRunContains(errors, cleanup, 'rm -rf "${DOCKER_CONFIG}"');
}

function validateIssue2478CrashLoopRecoveryVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "issue-2478-crash-loop-recovery-vitest";
  const scenarioName = "issue-2478-crash-loop-recovery";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing issue-2478-crash-loop-recovery-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("issue-2478-crash-loop-recovery-vitest job must run on ubuntu-latest");
  }
  if (job["timeout-minutes"] !== 30) {
    errors.push("issue-2478-crash-loop-recovery-vitest job must keep the 30 minute timeout");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, scenarioName);

  const jobEnv = asRecord(job.env);
  if ("DOCKER_CONFIG" in jobEnv) {
    errors.push(
      "issue-2478-crash-loop-recovery-vitest job must not set DOCKER_CONFIG at job level",
    );
  }
  const expectedEnv: Record<string, string> = {
    FREE_STANDING_VITEST_JOB: "1",
    FREE_STANDING_SCENARIO_ID: scenarioName,
    E2E_ARTIFACT_DIR: "${{ github.workspace }}/e2e-artifacts/vitest/issue-2478-crash-loop-recovery",
    NEMOCLAW_CLI_BIN: "${{ github.workspace }}/bin/nemoclaw.js",
    NEMOCLAW_RUN_E2E_SCENARIOS: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SANDBOX_NAME: "e2e-2478",
    OPENSHELL_GATEWAY: "nemoclaw",
  };
  for (const [key, value] of Object.entries(expectedEnv)) {
    if (jobEnv[key] !== value) {
      errors.push(`issue-2478-crash-loop-recovery-vitest job env ${key} must be ${value}`);
    }
  }
  for (const secret of ["NVIDIA_INFERENCE_API_KEY", ...COMMON_SECRET_ENV_NAMES]) {
    requireEnvDoesNotExposeSecret(
      errors,
      "issue-2478-crash-loop-recovery-vitest job",
      jobEnv,
      secret,
    );
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `issue-2478-crash-loop-recovery-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_API_KEY");
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "GITHUB_TOKEN");
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) {
    errors.push("issue-2478-crash-loop-recovery-vitest job missing checkout step");
  }
  requireFullShaAction(errors, checkout, "issue-2478-crash-loop-recovery-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push(
      "issue-2478-crash-loop-recovery-vitest checkout step must set persist-credentials=false",
    );
  }

  const configureDockerAuth = requireJobStep(
    errors,
    jobName,
    steps,
    "Configure isolated Docker auth directory",
  );
  requireRunContains(
    errors,
    configureDockerAuth,
    'echo "DOCKER_CONFIG=${RUNNER_TEMP}/docker-config-issue-2478-crash-loop-recovery" >> "$GITHUB_ENV"',
  );
  requireRunDoesNotContain(errors, configureDockerAuth, "${{ runner.temp }}");
  requireRunDoesNotContain(errors, configureDockerAuth, "${{ github.workspace }}");

  const dockerLogin = requireJobStep(errors, jobName, steps, "Authenticate to Docker Hub");
  const dockerLoginEnv = asRecord(dockerLogin?.env);
  if (dockerLoginEnv.DOCKERHUB_USERNAME !== "${{ secrets.DOCKERHUB_USERNAME }}") {
    errors.push(
      "issue-2478-crash-loop-recovery-vitest Docker Hub auth must receive DOCKERHUB_USERNAME from secrets",
    );
  }
  if (dockerLoginEnv.DOCKERHUB_TOKEN !== "${{ secrets.DOCKERHUB_TOKEN }}") {
    errors.push(
      "issue-2478-crash-loop-recovery-vitest Docker Hub auth must receive DOCKERHUB_TOKEN from secrets",
    );
  }
  requireRunContains(errors, dockerLogin, 'mkdir -p "${DOCKER_CONFIG}"');
  requireRunContains(errors, dockerLogin, 'chmod 700 "${DOCKER_CONFIG}"');
  requireRunContains(errors, dockerLogin, "docker login docker.io");
  requireRunContains(errors, dockerLogin, "--password-stdin");
  requireRunContains(errors, dockerLogin, "continuing with anonymous pulls");

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) {
    errors.push("issue-2478-crash-loop-recovery-vitest job missing step: Set up Node");
  }
  requireFullShaAction(errors, setupNode, "issue-2478-crash-loop-recovery-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell CLI");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");

  const runVitest = requireJobStep(
    errors,
    jobName,
    steps,
    "Run issue #2478 crash-loop recovery live Vitest test",
  );
  const runVitestEnv = asRecord(runVitest?.env);
  requireEnvDoesNotExposeSecret(
    errors,
    "issue-2478-crash-loop-recovery-vitest Vitest step",
    runVitestEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(
    errors,
    runVitest,
    "test/e2e-scenario/live/issue-2478-crash-loop-recovery.test.ts",
  );

  const upload = requireJobStep(
    errors,
    jobName,
    steps,
    "Upload issue #2478 crash-loop recovery artifacts",
  );
  requireFullShaAction(errors, upload, "issue-2478-crash-loop-recovery-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-issue-2478-crash-loop-recovery") {
    errors.push("issue-2478-crash-loop-recovery-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/vitest/issue-2478-crash-loop-recovery/",
  );
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push(
      "issue-2478-crash-loop-recovery-vitest artifact upload must set include-hidden-files: false",
    );
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push(
      "issue-2478-crash-loop-recovery-vitest artifact upload must ignore missing fixture artifacts",
    );
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("issue-2478-crash-loop-recovery-vitest artifact upload retention-days must be 14");
  }

  const cleanup = requireJobStep(errors, jobName, steps, "Clean up Docker auth");
  if (cleanup?.if !== "always()") {
    errors.push("issue-2478-crash-loop-recovery-vitest Docker auth cleanup must always run");
  }
  requireRunContains(errors, cleanup, "docker logout docker.io");
  requireRunContains(errors, cleanup, 'rm -rf "${DOCKER_CONFIG}"');
}

function validateChannelsAddRemoveVitestJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "channels-add-remove-vitest";
  const scenarioName = "channels-add-remove";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing channels-add-remove-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("channels-add-remove-vitest job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, scenarioName);
  if (job["timeout-minutes"] !== 75) {
    errors.push("channels-add-remove-vitest job must keep the legacy 75 minute timeout");
  }
  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push("channels-add-remove-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/vitest/channels-add-remove"
  ) {
    errors.push(
      "channels-add-remove-vitest job must write artifacts under e2e-artifacts/vitest/channels-add-remove",
    );
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("channels-add-remove-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-channels-add-remove") {
    errors.push(
      "channels-add-remove-vitest job must set NEMOCLAW_SANDBOX_NAME=e2e-channels-add-remove",
    );
  }
  if (jobEnv.NEMOCLAW_NON_INTERACTIVE !== "1") {
    errors.push("channels-add-remove-vitest job must set NEMOCLAW_NON_INTERACTIVE=1");
  }
  if (jobEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    errors.push("channels-add-remove-vitest job must set NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("channels-add-remove-vitest job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  for (const secret of [
    "NVIDIA_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(errors, "channels-add-remove-vitest job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `channels-add-remove-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run channels add/remove live test") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_API_KEY");
    }
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "GITHUB_TOKEN");
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("channels-add-remove-vitest job missing checkout step");
  requireFullShaAction(errors, checkout, "channels-add-remove-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("channels-add-remove-vitest checkout step must set persist-credentials=false");
  }

  const dockerHubAuth = requireJobStep(errors, jobName, steps, "Authenticate to Docker Hub");
  const dockerHubEnv = asRecord(dockerHubAuth?.env);
  if (dockerHubEnv.DOCKERHUB_USERNAME !== "${{ secrets.DOCKERHUB_USERNAME }}") {
    errors.push(
      "channels-add-remove-vitest Docker Hub auth must receive DOCKERHUB_USERNAME from secrets",
    );
  }
  if (dockerHubEnv.DOCKERHUB_TOKEN !== "${{ secrets.DOCKERHUB_TOKEN }}") {
    errors.push(
      "channels-add-remove-vitest Docker Hub auth must receive DOCKERHUB_TOKEN from secrets",
    );
  }
  requireRunContains(errors, dockerHubAuth, "docker login docker.io");
  requireRunContains(errors, dockerHubAuth, "continuing with anonymous pulls");

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) errors.push("channels-add-remove-vitest job missing step: Set up Node");
  requireFullShaAction(errors, setupNode, "channels-add-remove-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");
  requireRunContains(errors, installOpenShell, "env -u DOCKER_CONFIG");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_USERNAME");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_TOKEN");
  requireRunContains(errors, installOpenShell, "-u NVIDIA_API_KEY");
  requireRunContains(errors, installOpenShell, "-u GITHUB_TOKEN");

  const runVitest = requireJobStep(errors, jobName, steps, "Run channels add/remove live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_API_KEY !== "${{ secrets.NVIDIA_API_KEY }}") {
    errors.push("channels-add-remove-vitest step must receive NVIDIA_API_KEY from secrets");
  }
  if (runVitestEnv.TELEGRAM_BOT_TOKEN !== "test-fake-telegram-token-add-remove-e2e") {
    errors.push("channels-add-remove-vitest step must set the fake Telegram token");
  }
  if (runVitestEnv.TELEGRAM_ALLOWED_IDS !== "123456789") {
    errors.push("channels-add-remove-vitest step must set TELEGRAM_ALLOWED_IDS");
  }
  if (runVitestEnv.TELEGRAM_REQUIRE_MENTION !== "0") {
    errors.push("channels-add-remove-vitest step must set TELEGRAM_REQUIRE_MENTION");
  }
  requireRunContains(errors, runVitest, "OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, runVitest, "test/e2e-scenario/live/channels-add-remove.test.ts");

  const upload = requireJobStep(errors, jobName, steps, "Upload channels add/remove artifacts");
  requireFullShaAction(errors, upload, "channels-add-remove-vitest upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-channels-add-remove") {
    errors.push("channels-add-remove-vitest artifact upload name must be stable");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/vitest/channels-add-remove/");
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push("channels-add-remove-vitest artifact upload must set include-hidden-files: false");
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push("channels-add-remove-vitest artifact upload must ignore missing fixture artifacts");
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push("channels-add-remove-vitest artifact upload retention-days must be 14");
  }
}

function validateBedrockRuntimeCompatibleAnthropicVitestJob(
  errors: string[],
  jobs: WorkflowRecord,
): void {
  const jobName = "bedrock-runtime-compatible-anthropic-vitest";
  const scenarioName = "bedrock-runtime-compatible-anthropic";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing bedrock-runtime-compatible-anthropic-vitest job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("bedrock-runtime-compatible-anthropic-vitest job must run on ubuntu-latest");
  }
  if (job["timeout-minutes"] !== 60) {
    errors.push("bedrock-runtime-compatible-anthropic-vitest timeout-minutes must be 60");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, scenarioName);

  const strategy = asRecord(job.strategy);
  if (strategy["fail-fast"] !== false) {
    errors.push("bedrock-runtime-compatible-anthropic-vitest strategy.fail-fast must be false");
  }
  const matrix = asRecord(strategy.matrix);
  if (!Array.isArray(matrix.agent) || matrix.agent.join(",") !== "openclaw,hermes") {
    errors.push("bedrock-runtime-compatible-anthropic-vitest matrix.agent must be openclaw,hermes");
  }

  const jobEnv = asRecord(job.env);
  if ("DOCKER_CONFIG" in jobEnv) {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest job must not set DOCKER_CONFIG at job level",
    );
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !==
    "${{ github.workspace }}/e2e-artifacts/vitest/bedrock-runtime-compatible-anthropic/${{ matrix.agent }}"
  ) {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest job must write artifacts under e2e-artifacts/vitest/bedrock-runtime-compatible-anthropic/${{ matrix.agent }}",
    );
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI",
    );
  }
  if (jobEnv.NEMOCLAW_RUN_E2E_SCENARIOS !== "1") {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1",
    );
  }
  if (jobEnv.NEMOCLAW_NON_INTERACTIVE !== "1") {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest job must set NEMOCLAW_NON_INTERACTIVE=1",
    );
  }
  if (jobEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest job must set NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1",
    );
  }
  if (jobEnv.NEMOCLAW_RECREATE_SANDBOX !== "1") {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest job must set NEMOCLAW_RECREATE_SANDBOX=1",
    );
  }
  if (jobEnv.NEMOCLAW_AGENT !== "${{ matrix.agent }}") {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest job must pass matrix.agent through NEMOCLAW_AGENT",
    );
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-bedrock-${{ matrix.agent }}") {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest job must derive NEMOCLAW_SANDBOX_NAME from matrix.agent",
    );
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest job must force OPENSHELL_GATEWAY=nemoclaw",
    );
  }
  for (const secret of [
    "NVIDIA_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(
      errors,
      "bedrock-runtime-compatible-anthropic-vitest job",
      jobEnv,
      secret,
    );
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `bedrock-runtime-compatible-anthropic-vitest step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_API_KEY");
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "GITHUB_TOKEN");
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) {
    errors.push("bedrock-runtime-compatible-anthropic-vitest job missing checkout step");
  }
  requireFullShaAction(errors, checkout, "bedrock-runtime-compatible-anthropic-vitest checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest checkout step must set persist-credentials=false",
    );
  }

  const configureDockerAuth = requireJobStep(
    errors,
    jobName,
    steps,
    "Configure isolated Docker auth directory",
  );
  requireRunContains(
    errors,
    configureDockerAuth,
    'echo "DOCKER_CONFIG=${RUNNER_TEMP}/docker-config-bedrock-runtime-compatible-anthropic-${{ matrix.agent }}" >> "$GITHUB_ENV"',
  );
  requireRunDoesNotContain(errors, configureDockerAuth, "${{ runner.temp }}");

  const dockerLogin = requireJobStep(errors, jobName, steps, "Authenticate to Docker Hub");
  const dockerLoginEnv = asRecord(dockerLogin?.env);
  if (dockerLoginEnv.DOCKERHUB_USERNAME !== "${{ secrets.DOCKERHUB_USERNAME }}") {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest Docker Hub auth must receive DOCKERHUB_USERNAME from secrets",
    );
  }
  if (dockerLoginEnv.DOCKERHUB_TOKEN !== "${{ secrets.DOCKERHUB_TOKEN }}") {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest Docker Hub auth must receive DOCKERHUB_TOKEN from secrets",
    );
  }
  requireRunContains(errors, dockerLogin, 'mkdir -p "${DOCKER_CONFIG}"');
  requireRunContains(errors, dockerLogin, 'chmod 700 "${DOCKER_CONFIG}"');
  requireRunContains(errors, dockerLogin, "docker login docker.io");
  requireRunContains(errors, dockerLogin, "--password-stdin");
  requireRunContains(errors, dockerLogin, "continuing with anonymous pulls");

  const setupNode = namedStep(steps, "Set up Node");
  if (!setupNode) {
    errors.push("bedrock-runtime-compatible-anthropic-vitest job missing step: Set up Node");
  }
  requireFullShaAction(errors, setupNode, "bedrock-runtime-compatible-anthropic-vitest setup-node");

  const installRootDependencies = requireJobStep(
    errors,
    jobName,
    steps,
    "Install root dependencies",
  );
  requireRunContains(errors, installRootDependencies, "npm ci --ignore-scripts");

  const buildCli = requireJobStep(errors, jobName, steps, "Build CLI");
  requireRunContains(errors, buildCli, "npm run build:cli");

  const runVitest = requireJobStep(
    errors,
    jobName,
    steps,
    "Run Bedrock Runtime compatible Anthropic live test",
  );
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(
    errors,
    runVitest,
    "test/e2e-scenario/live/bedrock-runtime-compatible-anthropic.test.ts",
  );
  requireRunDoesNotContain(errors, runVitest, "${{ inputs.");

  const upload = requireJobStep(
    errors,
    jobName,
    steps,
    "Upload Bedrock Runtime compatible Anthropic artifacts",
  );
  requireFullShaAction(
    errors,
    upload,
    "bedrock-runtime-compatible-anthropic-vitest upload-artifact",
  );
  const uploadWith = asRecord(upload?.with);
  if (
    uploadWith.name !==
    "e2e-vitest-scenarios-bedrock-runtime-compatible-anthropic-${{ matrix.agent }}"
  ) {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest artifact upload name must include matrix.agent",
    );
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/vitest/bedrock-runtime-compatible-anthropic/${{ matrix.agent }}/",
  );
  if (uploadWith["include-hidden-files"] !== false) {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest artifact upload must set include-hidden-files: false",
    );
  }
  if (uploadWith["if-no-files-found"] !== "ignore") {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest artifact upload must ignore missing fixture artifacts",
    );
  }
  if (uploadWith["retention-days"] !== 14) {
    errors.push(
      "bedrock-runtime-compatible-anthropic-vitest artifact upload retention-days must be 14",
    );
  }

  const cleanup = requireJobStep(errors, jobName, steps, "Clean up Docker auth");
  if (cleanup?.if !== "always()") {
    errors.push("bedrock-runtime-compatible-anthropic-vitest Docker auth cleanup must always run");
  }
  requireRunContains(errors, cleanup, "docker logout docker.io");
  requireRunContains(errors, cleanup, 'rm -rf "${DOCKER_CONFIG}"');
}

export function validateE2eVitestScenariosWorkflowBoundary(
  workflowPath = DEFAULT_VITEST_WORKFLOW_PATH,
): string[] {
  const workflow = readWorkflowRecord(workflowPath);
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
  const { errors: inventoryErrors, inventory: freeStandingInventory } =
    deriveFreeStandingJobsInventoryFromJobs(jobs);
  errors.push(...inventoryErrors);
  validateFreeStandingInventoryBoundary(errors, jobs, freeStandingInventory);
  const generateMatrix = asRecord(jobs["generate-matrix"]);
  if (Object.keys(generateMatrix).length === 0) errors.push("workflow missing generate-matrix job");
  if (generateMatrix["runs-on"] !== "ubuntu-latest") {
    errors.push("generate-matrix job must run on ubuntu-latest");
  }
  const generateOutputs = asRecord(generateMatrix.outputs);
  if (generateOutputs.matrix !== "${{ steps.matrix.outputs.matrix }}") {
    errors.push("generate-matrix job must expose matrix output");
  }
  if (generateOutputs.hermes_selected !== "${{ steps.matrix.outputs.hermes_selected }}") {
    errors.push("generate-matrix job must expose hermes_selected output");
  }
  const generateSteps = asSteps(generateMatrix.steps);
  requireNoDispatchInputInterpolation(errors, generateSteps);
  const generateCheckout = generateSteps.find((step) =>
    stringValue(step.uses).startsWith("actions/checkout@"),
  );
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
  if (generateEnv.JOBS !== "${{ inputs.jobs }}") {
    errors.push("matrix generation step must pass jobs through JOBS env");
  }
  if (generateEnv.SCENARIOS !== "${{ inputs.scenarios }}") {
    errors.push("matrix generation step must pass scenarios through SCENARIOS env");
  }
  requireRunContains(errors, generate, FREE_STANDING_WORKFLOW_INVENTORY_SCRIPT);
  requireRunContains(
    errors,
    generate,
    "free-standing workflow inventory must be data-only key=value",
  );
  requireRunContains(
    errors,
    generate,
    "free_standing_scenarios_csv must match scenario mapping keys",
  );
  requireRunContains(errors, generate, "Free-standing scenario maps to unknown job");
  requireRunContains(errors, generate, "Use either scenarios or jobs, not both");
  requireRunContains(errors, generate, "Unknown free-standing Vitest job");
  requireRunContains(errors, generate, 'matrix="[]"');
  requireRunContains(errors, generate, "npx tsx test/e2e-scenario/scenarios/run.ts");
  requireRunContains(errors, generate, "--emit-live-matrix");
  requireRunContains(errors, generate, "--scenarios");
  requireRunContains(errors, generate, "^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$");
  requireRunContains(errors, generate, "Invalid scenario input; use comma-separated scenario ids");
  requireRunContains(errors, generate, "Invalid jobs input; use comma-separated job ids");
  requireRunDoesNotContain(errors, generate, "Invalid jobs input: ${JOBS}");
  requireRunDoesNotContain(errors, generate, "Invalid scenario input: ${SCENARIOS}");
  requireRunDoesNotContain(errors, generate, "^[A-Za-z0-9._-]+");
  requireRunContains(errors, generate, "hermes_selected=false");
  requireRunContains(errors, generate, "hermes_selected=true");
  requireRunContains(
    errors,
    generate,
    'echo "hermes_selected=${hermes_selected}" >> "$GITHUB_OUTPUT"',
  );
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
  if (
    liveScenarios.if !== "${{ inputs.jobs == '' && needs.generate-matrix.outputs.matrix != '[]' }}"
  ) {
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
  requireEnvDoesNotExposeSecret(errors, "live-scenarios job", jobEnv, "NVIDIA_INFERENCE_API_KEY");

  const steps = asSteps(liveScenarios.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Run Vitest live E2E scenarios") {
      requireEnvDoesNotExposeSecret(
        errors,
        `step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "NVIDIA_INFERENCE_API_KEY",
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
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("Vitest step must receive NVIDIA_INFERENCE_API_KEY from secrets");
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
  requireRunContains(
    errors,
    summary,
    'Path(os.environ["E2E_ARTIFACT_DIR"]) / os.environ["SCENARIO_ID"]',
  );
  requireRunContains(errors, summary, "| Scenario | Manifest | Expected state | Suites | Phases |");
  requireRunContains(errors, summary, "SCENARIO_ID");

  const upload = requireStep(errors, steps, "Upload Vitest E2E artifacts");
  requireFullShaAction(errors, upload, "upload-artifact");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-vitest-scenarios-${{ matrix.id }}") {
    errors.push("artifact upload name must include matrix.id");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/vitest/${{ matrix.id }}/run-plan.json",
  );
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/vitest/${{ matrix.id }}/scenario.json",
  );
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
  validateSkillAgentVitestJob(errors, jobs);
  validateFreeStandingJobSelector(errors, jobs, "credential-migration-vitest");
  validateFreeStandingJobSelector(
    errors,
    jobs,
    "sessions-agents-cli-vitest",
    "sessions-agents-cli",
  );
  validateFreeStandingJobSelector(errors, jobs, "inference-routing-vitest", "inference-routing");
  validateCloudInferenceVitestJob(errors, jobs);
  validateRuntimeOverridesVitestJob(errors, jobs);
  validateDoubleOnboardVitestJob(errors, jobs);
  validateHermesE2EVitestJob(errors, jobs);
  validateHermesRootEntrypointSmokeVitestJob(errors, jobs);
  validateNetworkPolicyVitestJob(errors, jobs);
  validateCommonEgressAgentVitestJob(errors, jobs);
  validateShieldsConfigVitestJob(errors, jobs);
  validateRebuildOpenClawVitestJob(errors, jobs);
  validateSandboxRebuildVitestJob(errors, jobs);
  validateStateBackupRestoreVitestJob(errors, jobs);
  validateTokenRotationVitestJob(errors, jobs);
  validateMessagingCompatibleEndpointVitestJob(errors, jobs);
  validateFreeStandingJobSelector(
    errors,
    jobs,
    "openclaw-tui-chat-correlation-vitest",
    "openclaw-tui-chat-correlation",
  );
  validateFreeStandingJobSelector(errors, jobs, "gateway-guard-recovery");
  validateFreeStandingJobSelector(
    errors,
    jobs,
    "issue-4434-tui-unreachable-inference-vitest",
    "issue-4434-tui-unreachable-inference",
  );
  validateModelRouterProviderRoutedInferenceVitestJob(errors, jobs);
  validateFreeStandingJobSelector(
    errors,
    jobs,
    "gateway-drift-preflight-vitest",
    "gateway-drift-preflight",
  );

  validateFreeStandingJobSelector(
    errors,
    jobs,
    "openclaw-inference-switch-vitest",
    "openclaw-inference-switch",
  );

  validateBedrockRuntimeCompatibleAnthropicVitestJob(errors, jobs);

  validateIssue2478CrashLoopRecoveryVitestJob(errors, jobs);

  validateFreeStandingJobSelector(
    errors,
    jobs,
    "gateway-health-honest-vitest",
    "gateway-health-honest",
  );

  validateChannelsAddRemoveVitestJob(errors, jobs);

  const reportToPr = asRecord(jobs["report-to-pr"]);
  if (Object.keys(reportToPr).length === 0) {
    errors.push("workflow missing report-to-pr job");
  } else {
    const needs = Array.isArray(reportToPr.needs) ? reportToPr.needs : [];
    for (const required of ["generate-matrix", "live-scenarios"]) {
      if (!needs.includes(required)) errors.push(`report-to-pr job must wait for ${required}`);
    }
    validateFreeStandingInventoryCoverage(errors, jobs, needs, freeStandingInventory);
    const reportSteps = asSteps(reportToPr.steps);
    const report = requireJobStep(
      errors,
      "report-to-pr",
      reportSteps,
      "Post Vitest scenario results to PR",
    );
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
      errors.push(
        "step 'Post Vitest scenario results to PR' run script must include process.env.JOBS",
      );
    }
    if (!reportScript.includes("process.env.JOB_SCENARIOS")) {
      errors.push(
        "step 'Post Vitest scenario results to PR' run script must include process.env.JOB_SCENARIOS",
      );
    }
    if (!reportScript.includes("selectorValidationPassed")) {
      errors.push(
        "step 'Post Vitest scenario results to PR' run script must check selector validation before echoing selectors",
      );
    }
    if (!reportScript.includes("jobsRejected")) {
      errors.push(
        "step 'Post Vitest scenario results to PR' run script must omit rejected job selectors",
      );
    }
    if (!reportScript.includes("scenariosRejected")) {
      errors.push(
        "step 'Post Vitest scenario results to PR' run script must omit rejected scenario selectors",
      );
    }
    if (!reportScript.includes("**Requested jobs:**")) {
      errors.push(
        "step 'Post Vitest scenario results to PR' run script must include **Requested jobs:**",
      );
    }
    if (!reportScript.includes("**Requested scenarios:**")) {
      errors.push(
        "step 'Post Vitest scenario results to PR' run script must include **Requested scenarios:**",
      );
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
