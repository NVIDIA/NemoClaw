// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { validateDocsValidationWorkflowBoundary } from "./docs-validation-workflow-boundary.mts";
import { validateHermesDashboardWorkflowBoundary } from "./hermes-dashboard-workflow-boundary.mts";
import { validateHermesGpuStartupWorkflowBoundary } from "./hermes-gpu-startup-workflow-boundary.mts";
import { validateInferenceSwitchWorkflowBoundary } from "./inference-switch-workflow-boundary.mts";
import { validateE2eOperationsWorkflowBoundary } from "./operations-workflow-boundary.mts";
import { validatePrepareE2eWorkflowBoundary } from "./prepare-e2e-workflow-boundary.mts";
import { validateSandboxOperationsWorkflow } from "./sandbox-operations-workflow-boundary.mts";
import { validateSecurityPostureWorkflowBoundary } from "./security-posture-workflow-boundary.mts";
import { validateUploadE2eArtifactsWorkflowBoundary } from "./upload-e2e-artifacts-workflow-boundary.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_E2E_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
export const FREE_STANDING_WORKFLOW_INVENTORY_SCRIPT = "tools/e2e/workflow-inventory.mts";

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  name?: string;
  run?: string;
  uses?: string;
  with?: WorkflowRecord;
};

export interface FreeStandingJobsInventory {
  allowedJobs: string[];
  explicitOnlyJobs: string[];
  freeStandingTargets: string[];
  targetToJob: Map<string, string>;
}

type CachedFreeStandingJobsInventory = {
  mtimeMs: number;
  size: number;
  inventory: FreeStandingJobsInventory;
};

const SELECTOR_PATTERN = /^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$/;
const SELECTOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const FREE_STANDING_JOB_MARKER = "E2E_JOB";
const FREE_STANDING_TARGET_MARKER = "E2E_TARGET_ID";
const FREE_STANDING_DEFAULT_ENABLED_MARKER = "E2E_DEFAULT_ENABLED";
const COMMON_SECRET_ENV_NAMES = [
  "NVIDIA_API_KEY",
  "NVIDIA_INFERENCE_API_KEY",
  "DOCKERHUB_USERNAME",
  "DOCKERHUB_TOKEN",
  "GITHUB_TOKEN",
];
const FREE_STANDING_SELECTOR_SPECIAL_CASES = new Set([
  "full-e2e",
  "hermes-e2e",
  "hermes-root-entrypoint-smoke",
  "openclaw-tui-chat-correlation",
]);
const PUBLIC_NVIDIA_ENDPOINT_KEY_JOBS = new Set([
  "device-auth-health",
  "model-router-provider-routed-inference",
]);
const NO_IMAGE_E2E_JOBS = new Set([
  "docs-validation",
  "gateway-drift-preflight",
  "gateway-health-honest",
  "inference-routing",
  "onboard-negative-paths",
  "openshell-version-pin",
]);
const DOCKER_HUB_AUTH_STEP = "Authenticate to Docker Hub";
const DOCKER_HUB_CLEANUP_STEP = "Clean up Docker auth";
const DOCKER_HUB_CLEANUP_RUN = "bash .github/scripts/docker-auth-cleanup.sh";
const DOCKER_HUB_CLEANUP_KEYS = ["if", "name", "run", "shell"];
const TRUSTED_DOCKER_HUB_PREDICATE =
  "github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')";
const GUARDED_DOCKER_HUB_AUTH_REQUIRED = `\${{ ${TRUSTED_DOCKER_HUB_PREDICATE} && '1' || '0' }}`;
const GUARDED_DOCKER_HUB_USERNAME = `\${{ ${TRUSTED_DOCKER_HUB_PREDICATE} && secrets.DOCKERHUB_USERNAME || '' }}`;
const GUARDED_DOCKER_HUB_TOKEN = `\${{ ${TRUSTED_DOCKER_HUB_PREDICATE} && secrets.DOCKERHUB_TOKEN || '' }}`;

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
  const explicitOnlyJobs: string[] = [];
  const freeStandingTargets: string[] = [];
  const targetToJob = new Map<string, string>();

  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob);
    const env = asRecord(job.env);
    const hasJobMarker = Object.hasOwn(env, FREE_STANDING_JOB_MARKER);
    const hasTargetMarker = Object.hasOwn(env, FREE_STANDING_TARGET_MARKER);
    if (!hasJobMarker && !hasTargetMarker) continue;

    if (!SELECTOR_ID_PATTERN.test(jobId)) {
      errors.push(`free-standing workflow metadata contains invalid job id: ${jobId}`);
    }
    if (!hasJobMarker) {
      errors.push(
        `${jobId} job ${FREE_STANDING_TARGET_MARKER} requires ${FREE_STANDING_JOB_MARKER}`,
      );
      continue;
    }
    if (env[FREE_STANDING_JOB_MARKER] !== "1") {
      errors.push(`${jobId} job ${FREE_STANDING_JOB_MARKER} must be "1"`);
      continue;
    }

    allowedJobs.push(jobId);
    if (Object.hasOwn(env, FREE_STANDING_DEFAULT_ENABLED_MARKER)) {
      if (env[FREE_STANDING_DEFAULT_ENABLED_MARKER] !== "0") {
        errors.push(`${jobId} job ${FREE_STANDING_DEFAULT_ENABLED_MARKER} must be "0" when set`);
      } else {
        explicitOnlyJobs.push(jobId);
      }
    }
    if (!hasTargetMarker) continue;

    const target = env[FREE_STANDING_TARGET_MARKER];
    if (typeof target !== "string" || !SELECTOR_ID_PATTERN.test(target)) {
      errors.push(`${jobId} job ${FREE_STANDING_TARGET_MARKER} must be a selector id`);
      continue;
    }
    freeStandingTargets.push(target);
    targetToJob.set(target, jobId);
  }

  if (allowedJobs.length === 0) {
    errors.push("free-standing workflow metadata must declare at least one job");
  }
  for (const duplicate of findDuplicates(allowedJobs)) {
    errors.push(`free-standing workflow metadata repeats job id: ${duplicate}`);
  }
  for (const duplicate of findDuplicates(freeStandingTargets)) {
    errors.push(`free-standing workflow metadata repeats target id: ${duplicate}`);
  }

  return {
    errors,
    inventory: {
      allowedJobs,
      explicitOnlyJobs,
      freeStandingTargets,
      targetToJob,
    },
  };
}

const freeStandingJobsInventoryCache = new Map<string, CachedFreeStandingJobsInventory>();

function readWorkflowRecord(workflowPath: string): WorkflowRecord {
  return asRecord(YAML.parse(readFileSync(workflowPath, "utf-8")));
}

function cloneFreeStandingJobsInventory(
  inventory: FreeStandingJobsInventory,
): FreeStandingJobsInventory {
  return {
    allowedJobs: [...inventory.allowedJobs],
    explicitOnlyJobs: [...inventory.explicitOnlyJobs],
    freeStandingTargets: [...inventory.freeStandingTargets],
    targetToJob: new Map(inventory.targetToJob),
  };
}

export function validateFreeStandingWorkflowInventory(
  workflowPath = DEFAULT_E2E_WORKFLOW_PATH,
): string[] {
  const workflow = readWorkflowRecord(workflowPath);
  return deriveFreeStandingJobsInventoryFromJobs(asRecord(workflow.jobs)).errors;
}

export function readFreeStandingJobsInventory(
  workflowPath = DEFAULT_E2E_WORKFLOW_PATH,
): FreeStandingJobsInventory {
  const stats = statSync(workflowPath);
  const cached = freeStandingJobsInventoryCache.get(workflowPath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cloneFreeStandingJobsInventory(cached.inventory);
  }

  const workflow = readWorkflowRecord(workflowPath);
  const { errors, inventory } = deriveFreeStandingJobsInventoryFromJobs(asRecord(workflow.jobs));
  if (errors.length > 0) {
    throw new Error(`Invalid free-standing workflow inventory:\n${errors.join("\n")}`);
  }
  freeStandingJobsInventoryCache.set(workflowPath, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    inventory: cloneFreeStandingJobsInventory(inventory),
  });
  return inventory;
}

export function formatFreeStandingJobsInventoryForShell(
  inventory: FreeStandingJobsInventory,
): string {
  const targetJobMappings = [...inventory.targetToJob].map(([target, job]) => `${target}:${job}`);
  return [
    `allowed_jobs=${inventory.allowedJobs.join(",")}`,
    `explicit_only_jobs_csv=${inventory.explicitOnlyJobs.join(",")}`,
    `free_standing_targets_csv=${inventory.freeStandingTargets.join(",")}`,
    `free_standing_target_jobs_csv=${targetJobMappings.join(",")}`,
    "",
  ].join("\n");
}

export interface WorkflowDispatchSelectorEvaluation {
  valid: boolean;
  errors: string[];
  selectedFreeStandingJobs: string[];
  registryTargets: string[];
  liveTargetsRun: boolean;
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

export function evaluateE2eWorkflowDispatchSelectors(input: {
  jobs?: string;
  targets?: string;
}): WorkflowDispatchSelectorEvaluation {
  const inventory = readFreeStandingJobsInventory();
  const freeStandingJobIds = inventory.allowedJobs;
  const freeStandingTargetToJob = inventory.targetToJob;
  const jobs = input.jobs ?? "";
  const targets = input.targets ?? "";
  const errors: string[] = [];

  if (jobs && targets) {
    errors.push("Use either targets or jobs, not both");
  }
  if (targets && !SELECTOR_PATTERN.test(targets)) {
    errors.push("Invalid target input");
  }
  if (jobs && !SELECTOR_PATTERN.test(jobs)) {
    errors.push("Invalid jobs input");
  }
  if (jobs && SELECTOR_PATTERN.test(jobs)) {
    for (const job of splitSelector(jobs)) {
      if (!freeStandingJobIds.includes(job)) {
        errors.push(`Unknown free-standing E2E job: ${job}`);
      }
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      selectedFreeStandingJobs: [],
      registryTargets: [],
      liveTargetsRun: false,
    };
  }

  if (!jobs && !targets) {
    return {
      valid: true,
      errors: [],
      selectedFreeStandingJobs: freeStandingJobIds
        .filter((job) => !inventory.explicitOnlyJobs.includes(job))
        .sort(),
      registryTargets: [],
      liveTargetsRun: true,
    };
  }

  if (jobs) {
    return {
      valid: true,
      errors: [],
      selectedFreeStandingJobs: splitSelector(jobs).sort(),
      registryTargets: [],
      liveTargetsRun: false,
    };
  }

  const selectedFreeStandingJobs = new Set<string>();
  const registryTargets: string[] = [];
  for (const target of splitSelector(targets)) {
    const job = freeStandingTargetToJob.get(target);
    if (job) selectedFreeStandingJobs.add(job);
    else registryTargets.push(target);
  }

  return {
    valid: true,
    errors: [],
    selectedFreeStandingJobs: [...selectedFreeStandingJobs].sort(),
    registryTargets,
    liveTargetsRun: registryTargets.length > 0,
  };
}

function namedStep(steps: readonly WorkflowStep[], name: string): WorkflowStep | undefined {
  return steps.find((step) => step.name === name);
}

function requireInput(errors: string[], inputs: WorkflowRecord, name: string): WorkflowRecord {
  if (!Object.hasOwn(inputs, name)) {
    errors.push(`workflow_dispatch missing input: ${name}`);
    return {};
  }
  return asRecord(inputs[name]);
}

function requireStep(
  errors: string[],
  steps: readonly WorkflowStep[],
  name: string,
): WorkflowStep | undefined {
  const step = namedStep(steps, name);
  if (!step) errors.push(`run-target job missing step: ${name}`);
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

function validateInlineHostDependencyInstall(
  errors: string[],
  jobName: string,
  steps: readonly WorkflowStep[],
  stepName: string,
  expectedPackages: readonly string[],
): void {
  const step = requireJobStep(errors, jobName, steps, stepName);
  if (step?.uses) {
    errors.push(`${jobName} host dependency setup must stay inline in trusted workflow YAML`);
  }
  for (const fragment of [
    "for attempt in 1 2 3",
    "sudo apt-get update",
    'if [ "$attempt" -eq 3 ]; then',
    "apt-get update failed after 3 attempts",
    "sleep $((attempt * 5))",
  ]) {
    requireRunContains(errors, step, fragment);
  }

  const installPrefix = "sudo apt-get install -y --no-install-recommends ";
  const installLines = stringValue(step?.run)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("sudo apt-get install "));
  const expectedInstall = `${installPrefix}${expectedPackages.join(" ")}`;
  if (installLines.length !== 1 || installLines[0] !== expectedInstall) {
    errors.push(`${jobName} host dependency install must be exactly '${expectedInstall}'`);
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

function requireScheduledRun(errors: string[], triggers: WorkflowRecord): void {
  const schedule = triggers.schedule;
  if (!Array.isArray(schedule)) {
    errors.push("workflow must support the scheduled E2E run");
    return;
  }
  const cronEntries = schedule
    .map((entry) => asRecord(entry).cron)
    .filter((cron): cron is string => typeof cron === "string");
  if (!cronEntries.includes("0 0 * * *")) {
    errors.push("workflow schedule must run daily at 00:00 UTC");
  }
}

function rejectUnexpectedTriggers(errors: string[], triggers: WorkflowRecord): void {
  for (const unsafe of ["push", "pull_request", "pull_request_target"]) {
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

function freeStandingJobIf(jobName: string, targetName?: string): string {
  const targetSelector = targetName
    ? ` || contains(format(',{0},', inputs.targets), ',${targetName},')`
    : "";
  return `\${{ (github.event_name != 'workflow_dispatch' || (inputs.jobs == '' && inputs.targets == '')) || contains(format(',{0},', inputs.jobs), ',${jobName},')${targetSelector} }}`;
}

function explicitOnlyFreeStandingJobIf(jobName: string, targetName?: string): string {
  const targetSelector = targetName
    ? ` || contains(format(',{0},', inputs.targets), ',${targetName},')`
    : "";
  return `\${{ contains(format(',{0},', inputs.jobs), ',${jobName},')${targetSelector} }}`;
}

function validateFreeStandingJobSelector(
  errors: string[],
  jobs: WorkflowRecord,
  jobName: string,
  targetName?: string,
  explicitOnly = false,
): void {
  const job = asRecord(jobs[jobName]);
  if (job.needs !== "generate-matrix") {
    errors.push(`${jobName} job must depend on generate-matrix`);
  }
  const expected = explicitOnly
    ? explicitOnlyFreeStandingJobIf(jobName, targetName)
    : freeStandingJobIf(jobName, targetName);
  if (job.if !== expected) {
    errors.push(`${jobName} job must use the shared jobs selector condition`);
  }
}

function validateGatewayGuardRecoveryJob(errors: string[], jobs: WorkflowRecord): void {
  const job = asRecord(jobs["gateway-guard-recovery"]);
  if (Object.keys(job).length === 0) return;
  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_E2E_USE_HOSTED_INFERENCE !== "1") {
    errors.push("gateway-guard-recovery job must enable hosted-compatible inference mode");
  }
}

function validateSerializedHostedAgentProofs(errors: string[], jobs: WorkflowRecord): void {
  const specs = [
    {
      jobName: "full-e2e",
      dependencies: ["generate-matrix", "token-rotation", "channels-stop-start"],
    },
    {
      jobName: "openclaw-tui-chat-correlation",
      dependencies: ["generate-matrix", "token-rotation", "channels-stop-start", "full-e2e"],
    },
  ] as const;

  for (const { dependencies, jobName } of specs) {
    const job = asRecord(jobs[jobName]);
    const needs = Array.isArray(job.needs) ? job.needs : [];
    if (
      needs.length !== dependencies.length ||
      dependencies.some((dependency) => !needs.includes(dependency))
    ) {
      errors.push(`${jobName} job must wait for ${dependencies.join(", ")}`);
    }
    const condition = stringValue(job.if);
    if (!condition.includes("always()")) {
      errors.push(`${jobName} job must remain runnable after skipped dependencies`);
    }
    for (const selector of ["inputs.jobs", "inputs.targets", `,${jobName},`]) {
      if (!condition.includes(selector)) {
        errors.push(`${jobName} job selector must include ${selector}`);
      }
    }
  }
}

function jobPassesNvidiaInferenceSecret(job: WorkflowRecord): boolean {
  return asSteps(job.steps).some(
    (step) => asRecord(step.env).NVIDIA_INFERENCE_API_KEY !== undefined,
  );
}

function validateHostedCompatibleInferenceFlag(
  errors: string[],
  jobName: string,
  jobEnv: WorkflowRecord,
): void {
  if (PUBLIC_NVIDIA_ENDPOINT_KEY_JOBS.has(jobName)) return;
  if (jobEnv.NEMOCLAW_E2E_USE_HOSTED_INFERENCE !== "1") {
    errors.push(`${jobName} job must enable hosted-compatible inference mode`);
  }
}

function validateFreeStandingInventoryBoundary(
  errors: string[],
  jobs: WorkflowRecord,
  inventory: FreeStandingJobsInventory,
): void {
  const targetByJob = new Map([...inventory.targetToJob].map(([target, job]) => [job, target]));

  for (const jobName of inventory.allowedJobs) {
    const job = asRecord(jobs[jobName]);
    if (Object.keys(job).length === 0) continue;

    if (!FREE_STANDING_SELECTOR_SPECIAL_CASES.has(jobName)) {
      validateFreeStandingJobSelector(
        errors,
        jobs,
        jobName,
        targetByJob.get(jobName),
        inventory.explicitOnlyJobs.includes(jobName),
      );
    }

    const jobEnv = asRecord(job.env);
    if (jobEnv.NEMOCLAW_RUN_LIVE_E2E === "1" && jobPassesNvidiaInferenceSecret(job)) {
      validateHostedCompatibleInferenceFlag(errors, jobName, jobEnv);
    }
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
  for (const [target, jobId] of inventory.targetToJob) {
    if (!inventory.allowedJobs.includes(jobId)) {
      errors.push(`free-standing inventory maps ${target} to unknown job ${jobId}`);
      continue;
    }
    const job = asRecord(jobs[jobId]);
    if (Object.keys(job).length === 0) continue;
    const jobIf = stringValue(job.if);
    const mappingIsRepresented =
      jobIf.includes(`contains(format(',{0},', inputs.targets), ',${target},')`) ||
      (jobId === "hermes-e2e" && jobIf.includes("needs.generate-matrix.outputs.hermes_selected"));
    if (!mappingIsRepresented) {
      errors.push(
        `free-standing inventory mapping ${target}:${jobId} must match the workflow job selector`,
      );
    }
  }
}

function validateOpenShellVersionPinJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "openshell-version-pin";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing openshell-version-pin job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("openshell-version-pin job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "openshell-version-pin");

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("openshell-version-pin job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/openshell-version-pin"
  ) {
    errors.push(
      "openshell-version-pin job must write artifacts under e2e-artifacts/live/openshell-version-pin",
    );
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "openshell-version-pin job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    requireEnvDoesNotExposeSecret(
      errors,
      `openshell-version-pin step '${step.name ?? step.uses ?? "<unnamed>"}'`,
      asRecord(step.env),
      "NVIDIA_INFERENCE_API_KEY",
    );
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("openshell-version-pin job missing checkout step");
  requireFullShaAction(errors, checkout, "openshell-version-pin checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("openshell-version-pin checkout step must set persist-credentials=false");
  }

  const runVitest = requireJobStep(errors, jobName, steps, "Run OpenShell version-pin live test");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/openshell-version-pin.test.ts");
}

function validateSkillAgentJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "skill-agent";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing skill-agent job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("skill-agent job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "skill-agent");

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("skill-agent job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/skill-agent") {
    errors.push("skill-agent job must write artifacts under e2e-artifacts/live/skill-agent");
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push("skill-agent job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  requireEnvDoesNotExposeSecret(errors, "skill-agent job", jobEnv, "NVIDIA_INFERENCE_API_KEY");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Run skill-agent live test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `skill-agent step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("skill-agent job missing checkout step");
  requireFullShaAction(errors, checkout, "skill-agent checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("skill-agent checkout step must set persist-credentials=false");
  }

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell CLI");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");

  const runVitest = requireJobStep(errors, jobName, steps, "Run skill-agent live test");
  const runEnv = asRecord(runVitest?.env);
  if (runEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("skill-agent run step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(
    errors,
    runVitest,
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"',
  );
  requireRunContains(errors, runVitest, 'OPENSHELL_BIN="$(command -v openshell)"');
  requireRunContains(errors, runVitest, "export OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/skill-agent.test.ts");
}

function validateNetworkPolicyJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "network-policy";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing network-policy job");
    return;
  }
  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("network-policy job must run on ubuntu-latest");
  }
  if (job.needs !== "generate-matrix") {
    errors.push("network-policy job must depend on generate-matrix");
  }
  if (job.if !== freeStandingJobIf(jobName, "network-policy")) {
    errors.push("network-policy job must map targets=network-policy to the network-policy job");
  }

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("network-policy job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/network-policy") {
    errors.push("network-policy job must write artifacts under e2e-artifacts/live/network-policy");
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push("network-policy job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("network-policy job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  for (const secret of [
    "NVIDIA_INFERENCE_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(errors, "network-policy job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = step.name ?? step.uses ?? "<unnamed>";
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run network-policy live test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `network-policy step '${stepName}'`,
        stepEnv,
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(
        errors,
        `network-policy step '${stepName}'`,
        stepEnv,
        "DOCKERHUB_USERNAME",
      );
      requireEnvDoesNotExposeSecret(
        errors,
        `network-policy step '${stepName}'`,
        stepEnv,
        "DOCKERHUB_TOKEN",
      );
    }
    requireEnvDoesNotExposeSecret(
      errors,
      `network-policy step '${stepName}'`,
      stepEnv,
      "GITHUB_TOKEN",
    );
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("network-policy job missing checkout step");
  requireFullShaAction(errors, checkout, "network-policy checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("network-policy checkout step must set persist-credentials=false");
  }

  validateInlineHostDependencyInstall(
    errors,
    jobName,
    steps,
    "Install network-policy host dependencies",
    ["expect"],
  );

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
    errors.push("network-policy live E2E step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/network-policy.test.ts");
}

function validateIssue4434HostDependencies(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "issue-4434-tui-unreachable-inference";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push(`workflow missing ${jobName} job`);
    return;
  }
  validateInlineHostDependencyInstall(
    errors,
    jobName,
    asSteps(job.steps),
    "Install issue #4434 host dependencies",
    ["expect", "iptables"],
  );
}

function validateCommonEgressAgentJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "common-egress-agent";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing common-egress-agent job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("common-egress-agent job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "common-egress-agent");
  if (job["timeout-minutes"] !== 120) {
    errors.push("common-egress-agent job must keep the legacy 120 minute timeout");
  }

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("common-egress-agent job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/common-egress-agent"
  ) {
    errors.push(
      "common-egress-agent job must write artifacts under e2e-artifacts/live/common-egress-agent",
    );
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push("common-egress-agent job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.NEMOCLAW_NON_INTERACTIVE !== "1") {
    errors.push("common-egress-agent job must set NEMOCLAW_NON_INTERACTIVE=1");
  }
  if (jobEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    errors.push("common-egress-agent job must set NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
  }
  if (jobEnv.NEMOCLAW_RECREATE_SANDBOX !== "1") {
    errors.push("common-egress-agent job must set NEMOCLAW_RECREATE_SANDBOX=1");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("common-egress-agent job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  for (const secret of [
    "NVIDIA_INFERENCE_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(errors, "common-egress-agent job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = step.name ?? step.uses ?? "<unnamed>";
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run common-egress agent live test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `common-egress-agent step '${stepName}'`,
        stepEnv,
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
    const forbiddenSecrets =
      step.name === DOCKER_HUB_AUTH_STEP
        ? ["GITHUB_TOKEN"]
        : ["DOCKERHUB_USERNAME", "DOCKERHUB_TOKEN", "GITHUB_TOKEN"];
    for (const secret of forbiddenSecrets) {
      requireEnvDoesNotExposeSecret(
        errors,
        `common-egress-agent step '${stepName}'`,
        stepEnv,
        secret,
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("common-egress-agent job missing checkout step");
  requireFullShaAction(errors, checkout, "common-egress-agent checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("common-egress-agent checkout step must set persist-credentials=false");
  }

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");
  requireRunContains(errors, installOpenShell, "env -u DOCKER_CONFIG");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_USERNAME");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_TOKEN");
  requireRunContains(errors, installOpenShell, "-u NVIDIA_INFERENCE_API_KEY");
  requireRunContains(errors, installOpenShell, "-u GITHUB_TOKEN");

  const runVitest = requireJobStep(errors, jobName, steps, "Run common-egress agent live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("common-egress-agent step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/common-egress-agent.test.ts");
}

function validateShieldsConfigJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "shields-config";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing shields-config job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("shields-config job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "shields-config");
  if (job["timeout-minutes"] !== 45) {
    errors.push("shields-config job must keep the legacy 45 minute timeout");
  }
  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("shields-config job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/shields-config") {
    errors.push("shields-config job must write artifacts under e2e-artifacts/live/shields-config");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("shields-config job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  if (jobEnv.NEMOCLAW_NON_INTERACTIVE !== "1") {
    errors.push("shields-config job must set NEMOCLAW_NON_INTERACTIVE=1");
  }
  if (jobEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    errors.push("shields-config job must set NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-shields") {
    errors.push("shields-config job must set NEMOCLAW_SANDBOX_NAME=e2e-shields");
  }
  requireEnvDoesNotExposeSecret(errors, "shields-config job", jobEnv, "NVIDIA_INFERENCE_API_KEY");
  requireEnvDoesNotExposeSecret(errors, "shields-config job", jobEnv, "DOCKERHUB_USERNAME");
  requireEnvDoesNotExposeSecret(errors, "shields-config job", jobEnv, "DOCKERHUB_TOKEN");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = step.name ?? step.uses ?? "<unnamed>";
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run shields-config live test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `shields-config step '${stepName}'`,
        stepEnv,
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(
        errors,
        `shields-config step '${stepName}'`,
        stepEnv,
        "DOCKERHUB_USERNAME",
      );
      requireEnvDoesNotExposeSecret(
        errors,
        `shields-config step '${stepName}'`,
        stepEnv,
        "DOCKERHUB_TOKEN",
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("shields-config job missing checkout step");
  requireFullShaAction(errors, checkout, "shields-config checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("shields-config checkout step must set persist-credentials=false");
  }

  const runVitest = requireJobStep(errors, jobName, steps, "Run shields-config live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("shields-config step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/shields-config.test.ts");
}

function validateRebuildOpenClawJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "rebuild-openclaw";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing rebuild-openclaw job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("rebuild-openclaw job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "rebuild-openclaw");
  if (job["timeout-minutes"] !== 130) {
    errors.push("rebuild-openclaw job must keep the legacy 130 minute timeout");
  }
  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("rebuild-openclaw job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/rebuild-openclaw") {
    errors.push(
      "rebuild-openclaw job must write artifacts under e2e-artifacts/live/rebuild-openclaw",
    );
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push("rebuild-openclaw job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  requireEnvDoesNotExposeSecret(errors, "rebuild-openclaw job", jobEnv, "NVIDIA_INFERENCE_API_KEY");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Run OpenClaw rebuild live test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `rebuild-openclaw step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("rebuild-openclaw job missing checkout step");
  requireFullShaAction(errors, checkout, "rebuild-openclaw checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("rebuild-openclaw checkout step must set persist-credentials=false");
  }

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell");
  requireEnvDoesNotExposeSecret(
    errors,
    "rebuild-openclaw step 'Install OpenShell'",
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
    errors.push("rebuild-openclaw step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/rebuild-openclaw.test.ts");
}

function validateRebuildHermesJob(
  errors: string[],
  jobs: WorkflowRecord,
  options: { staleBase: boolean },
): void {
  const jobName = options.staleBase ? "rebuild-hermes-stale-base" : "rebuild-hermes";
  const targetName = options.staleBase ? "rebuild-hermes-stale-base" : "rebuild-hermes";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push(`workflow missing ${jobName} job`);
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push(`${jobName} job must run on ubuntu-latest`);
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);
  if (job["timeout-minutes"] !== 90) {
    errors.push(`${jobName} job must keep the legacy 90 minute timeout`);
  }
  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push(`${jobName} job must set NEMOCLAW_RUN_LIVE_E2E=1`);
  }
  const artifactRoot = options.staleBase
    ? "${{ github.workspace }}/e2e-artifacts/live/rebuild-hermes-stale-base"
    : "${{ github.workspace }}/e2e-artifacts/live/rebuild-hermes";
  if (jobEnv.E2E_ARTIFACT_DIR !== artifactRoot) {
    errors.push(`${jobName} job must write artifacts under ${artifactRoot}`);
  }
  if (jobEnv.NEMOCLAW_AGENT !== "hermes") {
    errors.push(`${jobName} job must set NEMOCLAW_AGENT=hermes`);
  }
  if (jobEnv.NEMOCLAW_PROVIDER !== "custom") {
    errors.push(`${jobName} job must use the hosted compatible endpoint provider`);
  }
  if (jobEnv.NEMOCLAW_ENDPOINT_URL !== "https://inference-api.nvidia.com/v1") {
    errors.push(`${jobName} job must target hosted CI inference endpoint`);
  }
  if (jobEnv.NEMOCLAW_MODEL !== "nvidia/nvidia/nemotron-3-ultra") {
    errors.push(`${jobName} job must pin the CI-safe Hermes rebuild model`);
  }
  if (jobEnv.NEMOCLAW_COMPAT_MODEL !== "nvidia/nvidia/nemotron-3-ultra") {
    errors.push(`${jobName} job must pin the CI-safe compatible model`);
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push(`${jobName} job must force OPENSHELL_GATEWAY=nemoclaw`);
  }
  if (options.staleBase) {
    if (jobEnv.NEMOCLAW_HERMES_STALE_BASE_REBUILD_E2E !== "1") {
      errors.push(`${jobName} job must enable NEMOCLAW_HERMES_STALE_BASE_REBUILD_E2E=1`);
    }
    if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-rebuild-hermes-base") {
      errors.push(`${jobName} job must set NEMOCLAW_SANDBOX_NAME=e2e-rebuild-hermes-base`);
    }
  } else if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-rebuild-hermes") {
    errors.push(`${jobName} job must set NEMOCLAW_SANDBOX_NAME=e2e-rebuild-hermes`);
  }
  for (const secret of [
    "NVIDIA_INFERENCE_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(errors, `${jobName} job`, jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `${jobName} step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (!step.name?.startsWith("Run Hermes")) {
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
  if (!checkout) errors.push(`${jobName} job missing checkout step`);
  requireFullShaAction(errors, checkout, `${jobName} checkout`);
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push(`${jobName} checkout step must set persist-credentials=false`);
  }

  const runVitest = requireJobStep(
    errors,
    jobName,
    steps,
    options.staleBase ? "Run Hermes stale-base rebuild live test" : "Run Hermes rebuild live test",
  );
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push(`${jobName} step must receive NVIDIA_INFERENCE_API_KEY from secrets`);
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/rebuild-hermes.test.ts");
}

function validateSandboxRebuildJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "sandbox-rebuild";
  const targetName = "sandbox-rebuild";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing sandbox-rebuild job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("sandbox-rebuild job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);
  if (job["timeout-minutes"] !== 90) {
    errors.push("sandbox-rebuild job must keep the legacy 90 minute timeout");
  }
  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("sandbox-rebuild job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/sandbox-rebuild") {
    errors.push(
      "sandbox-rebuild job must write artifacts under e2e-artifacts/live/sandbox-rebuild",
    );
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("sandbox-rebuild job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("sandbox-rebuild job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  for (const secret of [
    "NVIDIA_INFERENCE_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(errors, "sandbox-rebuild job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `sandbox-rebuild step '${step.name ?? step.uses ?? "<unnamed>"}'`;
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
  if (!checkout) errors.push("sandbox-rebuild job missing checkout step");
  requireFullShaAction(errors, checkout, "sandbox-rebuild checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("sandbox-rebuild checkout step must set persist-credentials=false");
  }

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
    errors.push("sandbox-rebuild step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/sandbox-rebuild.test.ts");
}

function validateStateBackupRestoreJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "state-backup-restore";
  const targetName = "state-backup-restore";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing state-backup-restore job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("state-backup-restore job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);
  if (job["timeout-minutes"] !== 60) {
    errors.push("state-backup-restore job must keep the legacy 60 minute timeout");
  }
  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("state-backup-restore job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/state-backup-restore"
  ) {
    errors.push(
      "state-backup-restore job must write artifacts under e2e-artifacts/live/state-backup-restore",
    );
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("state-backup-restore job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("state-backup-restore job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  if (jobEnv.NEMOCLAW_NON_INTERACTIVE !== "1") {
    errors.push("state-backup-restore job must set NEMOCLAW_NON_INTERACTIVE=1");
  }
  if (jobEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    errors.push("state-backup-restore job must set NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-state-backup") {
    errors.push("state-backup-restore job must set NEMOCLAW_SANDBOX_NAME=e2e-state-backup");
  }
  for (const secret of [
    "NVIDIA_INFERENCE_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(errors, "state-backup-restore job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `state-backup-restore step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run state backup restore live test") {
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
  if (!checkout) errors.push("state-backup-restore job missing checkout step");
  requireFullShaAction(errors, checkout, "state-backup-restore checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("state-backup-restore checkout step must set persist-credentials=false");
  }

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");
  requireRunContains(errors, installOpenShell, "env -u DOCKER_CONFIG");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_USERNAME");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_TOKEN");
  requireRunContains(errors, installOpenShell, "-u NVIDIA_INFERENCE_API_KEY");
  requireRunContains(errors, installOpenShell, "-u GITHUB_TOKEN");

  const runVitest = requireJobStep(errors, jobName, steps, "Run state backup restore live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("state-backup-restore step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/state-backup-restore.test.ts");
}

function validateUpgradeStaleSandboxJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "upgrade-stale-sandbox";
  const targetName = "upgrade-stale-sandbox";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing upgrade-stale-sandbox job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("upgrade-stale-sandbox job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);
  if (job["timeout-minutes"] !== 55) {
    errors.push("upgrade-stale-sandbox job must keep the legacy 55 minute timeout");
  }

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("upgrade-stale-sandbox job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/upgrade-stale-sandbox"
  ) {
    errors.push(
      "upgrade-stale-sandbox job must write artifacts under e2e-artifacts/live/upgrade-stale-sandbox",
    );
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("upgrade-stale-sandbox job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("upgrade-stale-sandbox job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-upgrade-stale") {
    errors.push("upgrade-stale-sandbox job must set NEMOCLAW_SANDBOX_NAME=e2e-upgrade-stale");
  }
  if ("DOCKER_CONFIG" in jobEnv) {
    errors.push("upgrade-stale-sandbox job must not set DOCKER_CONFIG at job level");
  }
  for (const secret of [...COMMON_SECRET_ENV_NAMES]) {
    requireEnvDoesNotExposeSecret(errors, "upgrade-stale-sandbox job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `upgrade-stale-sandbox step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run upgrade stale sandbox live Vitest test") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
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
  if (!checkout) errors.push("upgrade-stale-sandbox job missing checkout step");
  requireFullShaAction(errors, checkout, "upgrade-stale-sandbox checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("upgrade-stale-sandbox checkout step must set persist-credentials=false");
  }

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell CLI");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");
  requireRunContains(errors, installOpenShell, "env -u DOCKER_CONFIG");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_USERNAME");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_TOKEN");
  requireRunContains(errors, installOpenShell, "-u NVIDIA_INFERENCE_API_KEY");
  requireRunContains(errors, installOpenShell, "-u GITHUB_TOKEN");

  const runVitest = requireJobStep(
    errors,
    jobName,
    steps,
    "Run upgrade stale sandbox live Vitest test",
  );
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("upgrade-stale-sandbox step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/upgrade-stale-sandbox.test.ts");
}

function validateTokenRotationJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "token-rotation";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing token-rotation job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("token-rotation job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "token-rotation");
  if (job["timeout-minutes"] !== 45) {
    errors.push("token-rotation job must keep the legacy 45 minute timeout");
  }
  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("token-rotation job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/token-rotation") {
    errors.push("token-rotation job must write artifacts under e2e-artifacts/live/token-rotation");
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push("token-rotation job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  requireEnvDoesNotExposeSecret(errors, "token-rotation job", jobEnv, "NVIDIA_INFERENCE_API_KEY");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Run token rotation live test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `token-rotation step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("token-rotation job missing checkout step");
  requireFullShaAction(errors, checkout, "token-rotation checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("token-rotation checkout step must set persist-credentials=false");
  }

  const runVitest = requireJobStep(errors, jobName, steps, "Run token rotation live test");
  const runVitestEnv = asRecord(runVitest?.env);
  requireEnvDoesNotExposeSecret(
    errors,
    "token-rotation step",
    runVitestEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );
  if (runVitestEnv.GITHUB_TOKEN !== "${{ github.token }}") {
    errors.push("token-rotation step must receive GITHUB_TOKEN from github.token");
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
      errors.push(`token-rotation step must set ${tokenName}`);
    }
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/token-rotation.test.ts");
}

function validateMessagingCompatibleEndpointJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "messaging-compatible-endpoint";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing messaging-compatible-endpoint job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("messaging-compatible-endpoint job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "messaging-compatible-endpoint");
  if (job["timeout-minutes"] !== 45) {
    errors.push("messaging-compatible-endpoint job must keep the legacy 45 minute timeout");
  }

  const jobEnv = asRecord(job.env);
  if (
    jobEnv.E2E_ARTIFACT_DIR !==
    "${{ github.workspace }}/e2e-artifacts/live/messaging-compatible-endpoint"
  ) {
    errors.push(
      "messaging-compatible-endpoint job must write artifacts under e2e-artifacts/live/messaging-compatible-endpoint",
    );
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push("messaging-compatible-endpoint job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("messaging-compatible-endpoint job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-msg-compat") {
    errors.push("messaging-compatible-endpoint job must pin the legacy sandbox name");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("messaging-compatible-endpoint job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "messaging-compatible-endpoint job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );
  requireEnvDoesNotExposeSecret(
    errors,
    "messaging-compatible-endpoint job",
    jobEnv,
    "DOCKERHUB_USERNAME",
  );
  requireEnvDoesNotExposeSecret(
    errors,
    "messaging-compatible-endpoint job",
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
      `messaging-compatible-endpoint step '${stepName}'`,
      stepEnv,
      "NVIDIA_INFERENCE_API_KEY",
    );
    if (step.name !== DOCKER_HUB_AUTH_STEP) {
      requireEnvDoesNotExposeSecret(
        errors,
        `messaging-compatible-endpoint step '${stepName}'`,
        stepEnv,
        "DOCKERHUB_USERNAME",
      );
      requireEnvDoesNotExposeSecret(
        errors,
        `messaging-compatible-endpoint step '${stepName}'`,
        stepEnv,
        "DOCKERHUB_TOKEN",
      );
      requireNoDockerHubAuthInRun(
        errors,
        `messaging-compatible-endpoint step '${stepName}'`,
        stringValue(step.run),
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("messaging-compatible-endpoint job missing checkout step");
  requireFullShaAction(errors, checkout, "messaging-compatible-endpoint checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("messaging-compatible-endpoint checkout step must set persist-credentials=false");
  }

  const runVitest = requireJobStep(
    errors,
    jobName,
    steps,
    "Run messaging compatible endpoint live test",
  );
  const runVitestEnv = asRecord(runVitest?.env);
  requireEnvDoesNotExposeSecret(
    errors,
    "messaging-compatible-endpoint step",
    runVitestEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );
  if (runVitestEnv.NEMOCLAW_COMPAT_MOCK_API_KEY !== "fake-compatible-key-e2e") {
    errors.push("messaging-compatible-endpoint step must set a fake compatible endpoint key");
  }
  if (runVitestEnv.TELEGRAM_BOT_TOKEN !== "test-fake-telegram-token-e2e") {
    errors.push("messaging-compatible-endpoint step must set a fake Telegram token");
  }
  if (runVitestEnv.TELEGRAM_ALLOWED_IDS !== "123456789") {
    errors.push("messaging-compatible-endpoint step must set fake Telegram allowed ids");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/messaging-compatible-endpoint.test.ts");
}

function validateOnboardNegativePathsJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "onboard-negative-paths";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing onboard-negative-paths job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("onboard-negative-paths job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "onboard-negative-paths");

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("onboard-negative-paths job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/onboard-negative-paths"
  ) {
    errors.push(
      "onboard-negative-paths job must write artifacts under e2e-artifacts/live/onboard-negative-paths",
    );
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "onboard-negative-paths job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    requireEnvDoesNotExposeSecret(
      errors,
      `onboard-negative-paths step '${step.name ?? step.uses ?? "<unnamed>"}'`,
      asRecord(step.env),
      "NVIDIA_INFERENCE_API_KEY",
    );
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("onboard-negative-paths job missing checkout step");
  requireFullShaAction(errors, checkout, "onboard-negative-paths checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("onboard-negative-paths checkout step must set persist-credentials=false");
  }

  const runVitest = requireJobStep(errors, jobName, steps, "Run onboard negative-paths live test");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/onboard-negative-paths.test.ts");
}

function validateCloudInferenceJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "cloud-inference";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing cloud-inference job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("cloud-inference job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "cloud-inference");
  if (job["timeout-minutes"] !== 50) {
    errors.push("cloud-inference job must keep the 50 minute timeout");
  }

  const jobEnv = asRecord(job.env);
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/cloud-inference") {
    errors.push(
      "cloud-inference job must write artifacts under e2e-artifacts/live/cloud-inference",
    );
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("cloud-inference job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("cloud-inference job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-cloud-inference") {
    errors.push("cloud-inference job must set NEMOCLAW_SANDBOX_NAME=e2e-cloud-inference");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("cloud-inference job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  requireEnvDoesNotExposeSecret(errors, "cloud-inference job", jobEnv, "NVIDIA_INFERENCE_API_KEY");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Run cloud inference live test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `cloud-inference step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("cloud-inference job missing checkout step");
  requireFullShaAction(errors, checkout, "cloud-inference checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("cloud-inference checkout step must set persist-credentials=false");
  }

  const runVitest = requireJobStep(errors, jobName, steps, "Run cloud inference live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("cloud-inference run step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/cloud-inference.test.ts");
}

function requireNoDockerHubAuthInRun(errors: string[], owner: string, runScript: string): void {
  if (!runScript) return;
  const usesDockerLogin = /\bdocker\s+login\b/i.test(runScript);
  const referencesSecret = /\bsecrets\.[A-Za-z0-9_]+\b|\$\{\{\s*secrets\.[^}]+\}\}/.test(runScript);
  if (usesDockerLogin || referencesSecret) {
    errors.push(`${owner} run script must not use docker login or inline secret interpolation`);
  }
}

function requireCanonicalDockerHubAuthRun(
  errors: string[],
  authStep: WorkflowStep | undefined,
): void {
  if (!authStep) return;
  if (Object.hasOwn(authStep, "if")) {
    errors.push(
      "canonical Docker Hub auth step must always run so untrusted refs receive an isolated empty Docker config",
    );
  }
  if (authStep.shell !== "bash") {
    errors.push("canonical Docker Hub auth step must use bash");
  }
  if (authStep.uses !== undefined) {
    errors.push("canonical Docker Hub auth step must use the audited inline retry script");
  }
  if (authStep["continue-on-error"] !== undefined) {
    errors.push(
      "canonical Docker Hub auth step must fail closed when trusted authentication fails",
    );
  }

  const authEnv = asRecord(authStep.env);
  if (authEnv.DOCKERHUB_AUTH_REQUIRED !== GUARDED_DOCKER_HUB_AUTH_REQUIRED) {
    errors.push(
      "canonical Docker Hub auth must gate DOCKERHUB_AUTH_REQUIRED on the trusted repository, main ref, and scheduled/manual events",
    );
  }
  if (authEnv.DOCKERHUB_USERNAME !== GUARDED_DOCKER_HUB_USERNAME) {
    errors.push(
      "canonical Docker Hub auth must gate DOCKERHUB_USERNAME on the trusted repository, main ref, and scheduled/manual events",
    );
  }
  if (authEnv.DOCKERHUB_TOKEN !== GUARDED_DOCKER_HUB_TOKEN) {
    errors.push(
      "canonical Docker Hub auth must gate DOCKERHUB_TOKEN on the trusted repository, main ref, and scheduled/manual events",
    );
  }
  const unexpectedEnv = Object.keys(authEnv).filter(
    (name) => !["DOCKERHUB_AUTH_REQUIRED", "DOCKERHUB_USERNAME", "DOCKERHUB_TOKEN"].includes(name),
  );
  if (unexpectedEnv.length > 0) {
    errors.push("canonical Docker Hub auth step must expose only its three guarded inputs");
  }

  const runScript = stringValue(authStep.run);
  for (const fragment of [
    'mktemp -d "${RUNNER_TEMP}/docker-config-${GITHUB_JOB}-XXXXXX"',
    'chmod 700 "${docker_config}"',
    'export DOCKER_CONFIG="${docker_config}"',
    'if [[ "${DOCKERHUB_AUTH_REQUIRED}" != "1" ]]; then',
    "continuing with anonymous pulls",
    'if [[ -z "${DOCKERHUB_USERNAME}" || -z "${DOCKERHUB_TOKEN}" ]]; then',
    'auth_marker="${DOCKER_CONFIG}/.nemoclaw-docker-login-attempted"',
    ': > "${auth_marker}"',
    'chmod 600 "${auth_marker}"',
    "for attempt in 1 2 3; do",
    "timeout 30s docker login docker.io",
    '--username "${DOCKERHUB_USERNAME}"',
    "--password-stdin",
    "Docker Hub login failed after 3 attempts",
  ]) {
    if (!runScript.includes(fragment)) {
      errors.push(`canonical Docker Hub auth run script must include ${fragment}`);
    }
  }
  if (
    !runScript.includes("printf 'DOCKER_CONFIG=%s\\n'") ||
    !runScript.includes('"${DOCKER_CONFIG}"') ||
    !runScript.includes('>> "${GITHUB_ENV}"')
  ) {
    errors.push(
      "canonical Docker Hub auth run script must persist the isolated DOCKER_CONFIG through GITHUB_ENV",
    );
  }
  if (runScript.includes("${{ github.workspace }}") || runScript.includes("GITHUB_WORKSPACE")) {
    errors.push("canonical Docker Hub auth directory must not use the checkout workspace");
  }
  if (/--password(?:=|\s)(?!-stdin\b)/u.test(runScript)) {
    errors.push("canonical Docker Hub auth must pass the token only through --password-stdin");
  }

  const configIndex = runScript.indexOf(
    'mktemp -d "${RUNNER_TEMP}/docker-config-${GITHUB_JOB}-XXXXXX"',
  );
  const trustIndex = runScript.indexOf('if [[ "${DOCKERHUB_AUTH_REQUIRED}" != "1" ]]; then');
  const loginIndex = runScript.indexOf("docker login docker.io");
  if (configIndex < 0 || trustIndex <= configIndex || loginIndex <= trustIndex) {
    errors.push(
      "canonical Docker Hub auth must isolate Docker config before evaluating trust and authenticating",
    );
  }
  const missingCredentialsIndex = runScript.indexOf(
    'if [[ -z "${DOCKERHUB_USERNAME}" || -z "${DOCKERHUB_TOKEN}" ]]; then',
  );
  const missingCredentialsEndIndex = runScript.indexOf("\nfi", missingCredentialsIndex);
  const markerPathIndex = runScript.indexOf(
    'auth_marker="${DOCKER_CONFIG}/.nemoclaw-docker-login-attempted"',
  );
  const markerCreateIndex = runScript.indexOf(': > "${auth_marker}"');
  const markerChmodIndex = runScript.indexOf('chmod 600 "${auth_marker}"');
  const retryIndex = runScript.indexOf("for attempt in 1 2 3; do");
  const missingCredentialsBlock =
    missingCredentialsIndex >= 0 && retryIndex > missingCredentialsIndex
      ? runScript.slice(missingCredentialsIndex, retryIndex)
      : "";
  if (!missingCredentialsBlock.includes("exit 1")) {
    errors.push("canonical Docker Hub auth must fail when trusted credentials are missing");
  }
  if (
    missingCredentialsEndIndex < 0 ||
    markerPathIndex <= missingCredentialsEndIndex ||
    markerCreateIndex <= markerPathIndex ||
    markerChmodIndex <= markerCreateIndex ||
    retryIndex <= markerChmodIndex ||
    loginIndex <= retryIndex
  ) {
    errors.push(
      "canonical Docker Hub auth must create and protect its login-attempt marker after trusted credential validation and before login",
    );
  }
  const exhaustedLoginIndex = runScript.indexOf("Docker Hub login failed after 3 attempts");
  if (exhaustedLoginIndex < 0 || !runScript.slice(exhaustedLoginIndex).includes("exit 1")) {
    errors.push("canonical Docker Hub auth must fail after exhausting login retries");
  }
}

function requireCanonicalDockerHubCleanupRun(
  errors: string[],
  jobName: string,
  cleanupStep: WorkflowStep | undefined,
): void {
  if (!cleanupStep) return;

  const cleanupKeys = Object.keys(cleanupStep).sort();
  if (
    cleanupKeys.length !== DOCKER_HUB_CLEANUP_KEYS.length ||
    cleanupKeys.some((key, index) => key !== DOCKER_HUB_CLEANUP_KEYS[index])
  ) {
    errors.push(`${jobName} Docker Hub cleanup step must contain exactly name, if, shell, and run`);
  }
  if (cleanupStep.name !== DOCKER_HUB_CLEANUP_STEP) {
    errors.push(`${jobName} Docker Hub cleanup step must use the canonical name`);
  }
  if (cleanupStep.if !== "always()") {
    errors.push(`${jobName} Docker Hub cleanup step must always run`);
  }
  if (cleanupStep.shell !== "bash") {
    errors.push(`${jobName} Docker Hub cleanup step must use bash`);
  }
  if (cleanupStep.run !== DOCKER_HUB_CLEANUP_RUN) {
    errors.push(`${jobName} Docker Hub cleanup step must run only ${DOCKER_HUB_CLEANUP_RUN}`);
  }
}

function validateDockerHubAuthBoundary(errors: string[], jobs: WorkflowRecord): void {
  const e2eJobNames = Object.entries(jobs)
    .filter(([, rawJob]) => asRecord(asRecord(rawJob).env).E2E_JOB === "1")
    .map(([jobName]) => jobName);
  for (const exemptJobName of NO_IMAGE_E2E_JOBS) {
    if (!e2eJobNames.includes(exemptJobName)) {
      errors.push(`Docker Hub no-image exemption references unknown E2E job: ${exemptJobName}`);
    }
  }

  const imageJobNames = [
    "live",
    ...e2eJobNames.filter((jobName) => !NO_IMAGE_E2E_JOBS.has(jobName)),
  ];
  const liveSteps = asSteps(asRecord(jobs.live).steps);
  const canonicalAuth = namedStep(liveSteps, DOCKER_HUB_AUTH_STEP);
  requireCanonicalDockerHubAuthRun(errors, canonicalAuth);

  for (const jobName of imageJobNames) {
    const job = asRecord(jobs[jobName]);
    const jobEnv = asRecord(job.env);
    for (const variable of [
      "DOCKER_CONFIG",
      "DOCKERHUB_AUTH_REQUIRED",
      "DOCKERHUB_USERNAME",
      "DOCKERHUB_TOKEN",
    ]) {
      requireEnvDoesNotExposeSecret(errors, `${jobName} job`, jobEnv, variable);
    }

    const steps = asSteps(job.steps);
    const authSteps = steps.filter((step) => step.name === DOCKER_HUB_AUTH_STEP);
    const cleanupSteps = steps.filter((step) => step.name === DOCKER_HUB_CLEANUP_STEP);
    if (authSteps.length !== 1) {
      errors.push(`${jobName} image-consuming job must have exactly one Docker Hub auth step`);
    }
    if (cleanupSteps.length !== 1) {
      errors.push(`${jobName} image-consuming job must have exactly one Docker Hub cleanup step`);
    }
    const auth = authSteps[0];
    const cleanup = cleanupSteps[0];
    if (auth && canonicalAuth && auth !== canonicalAuth) {
      errors.push(`${jobName} Docker Hub auth must reuse the canonical workflow alias`);
    }
    requireCanonicalDockerHubCleanupRun(errors, jobName, cleanup);

    const checkoutIndex = steps.findIndex((step) =>
      stringValue(step.uses).startsWith("actions/checkout@"),
    );
    const authIndex = steps.indexOf(auth);
    const cleanupIndex = steps.indexOf(cleanup);
    if (checkoutIndex < 0 || authIndex !== checkoutIndex + 1) {
      errors.push(`${jobName} Docker Hub auth must run immediately after checkout`);
    }
    if (authIndex < 0 || cleanupIndex <= authIndex) {
      errors.push(`${jobName} Docker Hub cleanup must run after authentication and test work`);
    }
    if (cleanupIndex !== steps.length - 1) {
      errors.push(`${jobName} Docker Hub cleanup must be the final job step`);
    }

    for (const step of steps) {
      const stepName = `${jobName} step '${step.name ?? step.uses ?? "<unnamed>"}'`;
      const stepEnv = asRecord(step.env);
      if (step !== auth) {
        for (const variable of [
          "DOCKER_CONFIG",
          "DOCKERHUB_AUTH_REQUIRED",
          "DOCKERHUB_USERNAME",
          "DOCKERHUB_TOKEN",
        ]) {
          requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, variable);
        }
        const runScript = stringValue(step.run);
        if (/\bdocker\s+login\b/iu.test(runScript) || /secrets\.DOCKERHUB_/u.test(runScript)) {
          errors.push(`${stepName} must not authenticate or interpolate Docker Hub secrets`);
        }
        if (/DOCKER_CONFIG=.*GITHUB_ENV/su.test(runScript) && step !== cleanup) {
          errors.push(`${stepName} must not override the canonical Docker auth directory`);
        }
      }
    }
  }

  for (const jobName of NO_IMAGE_E2E_JOBS) {
    const steps = asSteps(asRecord(jobs[jobName]).steps);
    if (namedStep(steps, DOCKER_HUB_AUTH_STEP) || namedStep(steps, DOCKER_HUB_CLEANUP_STEP)) {
      errors.push(`${jobName} no-image job must not receive Docker Hub authentication`);
    }
  }

  const classifiedJobNames = new Set([...imageJobNames, ...NO_IMAGE_E2E_JOBS]);
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    if (classifiedJobNames.has(jobName)) continue;
    const steps = asSteps(asRecord(rawJob).steps);
    if (namedStep(steps, DOCKER_HUB_AUTH_STEP) || namedStep(steps, DOCKER_HUB_CLEANUP_STEP)) {
      errors.push(`${jobName} non-E2E job must not own the shared Docker Hub auth aliases`);
    }
  }
}

function validateDoubleOnboardJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "double-onboard";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing double-onboard job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("double-onboard job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "double-onboard");

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("double-onboard job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("double-onboard job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/double-onboard") {
    errors.push("double-onboard job must write artifacts under e2e-artifacts/live/double-onboard");
  }
  requireEnvDoesNotExposeSecret(errors, "double-onboard job", jobEnv, "NVIDIA_INFERENCE_API_KEY");
  requireEnvDoesNotExposeSecret(errors, "double-onboard job", jobEnv, "DOCKERHUB_TOKEN");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(
        errors,
        `double-onboard step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "DOCKERHUB_TOKEN",
      );
    }
    requireEnvDoesNotExposeSecret(
      errors,
      `double-onboard step '${step.name ?? step.uses ?? "<unnamed>"}'`,
      asRecord(step.env),
      "NVIDIA_INFERENCE_API_KEY",
    );
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("double-onboard job missing checkout step");
  requireFullShaAction(errors, checkout, "double-onboard checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("double-onboard checkout step must set persist-credentials=false");
  }

  const installTools = requireJobStep(errors, jobName, steps, "Install OpenShell CLI");
  requireRunContains(errors, installTools, "bash scripts/install-openshell.sh");

  const runVitest = requireJobStep(errors, jobName, steps, "Run double-onboard live Vitest test");
  requireRunContains(errors, runVitest, "OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/double-onboard.test.ts");
}
function validateRuntimeOverridesJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "runtime-overrides";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing runtime-overrides job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("runtime-overrides job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, "runtime-overrides");

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("runtime-overrides job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/runtime-overrides") {
    errors.push(
      "runtime-overrides job must write artifacts under e2e-artifacts/live/runtime-overrides",
    );
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "runtime-overrides job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );
  requireEnvDoesNotExposeSecret(errors, "runtime-overrides job", jobEnv, "DOCKERHUB_USERNAME");
  requireEnvDoesNotExposeSecret(errors, "runtime-overrides job", jobEnv, "DOCKERHUB_TOKEN");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `runtime-overrides step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
    if (step.name !== DOCKER_HUB_AUTH_STEP) {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("runtime-overrides job missing checkout step");
  requireFullShaAction(errors, checkout, "runtime-overrides checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("runtime-overrides checkout step must set persist-credentials=false");
  }

  const runVitest = requireJobStep(errors, jobName, steps, "Run runtime overrides live test");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/runtime-overrides.test.ts");
}

function validateHermesE2EJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "hermes-e2e";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing hermes-e2e job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("hermes-e2e job must run on ubuntu-latest");
  }
  if (job.needs !== "generate-matrix") {
    errors.push("hermes-e2e job must depend on generate-matrix validation");
  }
  if (job.if !== "${{ needs.generate-matrix.outputs.hermes_selected == 'true' }}") {
    errors.push("hermes-e2e job must use validated hermes_selected output");
  }
  if (stringValue(job.if).includes("inputs.targets")) {
    errors.push("hermes-e2e job must not inspect raw workflow dispatch targets");
  }

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("hermes-e2e job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("hermes-e2e job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/hermes-e2e") {
    errors.push("hermes-e2e job must write artifacts under e2e-artifacts/live/hermes-e2e");
  }
  if (jobEnv.NEMOCLAW_AGENT !== "hermes") {
    errors.push("hermes-e2e job must set NEMOCLAW_AGENT=hermes");
  }
  if (jobEnv.NEMOCLAW_MODEL !== undefined) {
    errors.push("hermes-e2e job must use the shared hosted-compatible model default");
  }
  if (jobEnv.NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS !== "60") {
    errors.push("hermes-e2e job must give hosted endpoint validation a CI-safe timeout");
  }
  requireEnvDoesNotExposeSecret(errors, "hermes-e2e job", jobEnv, "NVIDIA_INFERENCE_API_KEY");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Run Hermes live Vitest test") {
      requireEnvDoesNotExposeSecret(
        errors,
        `hermes-e2e step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("hermes-e2e job missing checkout step");
  requireFullShaAction(errors, checkout, "hermes-e2e checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("hermes-e2e checkout step must set persist-credentials=false");
  }

  const runVitest = requireJobStep(errors, jobName, steps, "Run Hermes live Vitest test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("hermes-e2e live E2E step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/hermes-e2e.test.ts");
  requireRunDoesNotContain(errors, runVitest, "${{ inputs.");
}

function validateHermesRootEntrypointSmokeJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "hermes-root-entrypoint-smoke";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing hermes-root-entrypoint-smoke job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("hermes-root-entrypoint-smoke job must run on ubuntu-latest");
  }
  if (job.needs !== "generate-matrix") {
    errors.push("hermes-root-entrypoint-smoke job must depend on generate-matrix");
  }
  const expectedIf =
    "${{ needs.generate-matrix.result == 'success' && ((github.event_name != 'workflow_dispatch' || (inputs.jobs == '' && inputs.targets == '')) || contains(format(',{0},', inputs.jobs), ',hermes-root-entrypoint-smoke,') || contains(format(',{0},', inputs.targets), ',hermes-root-entrypoint-smoke,')) }}";
  if (job.if !== expectedIf) {
    errors.push(
      "hermes-root-entrypoint-smoke job must gate on generate-matrix and the shared selector condition",
    );
  }
  if (job["timeout-minutes"] !== 45) {
    errors.push("hermes-root-entrypoint-smoke job must keep the 45 minute timeout");
  }

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("hermes-root-entrypoint-smoke job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !==
    "${{ github.workspace }}/e2e-artifacts/live/hermes-root-entrypoint-smoke"
  ) {
    errors.push(
      "hermes-root-entrypoint-smoke job must write artifacts under e2e-artifacts/live/hermes-root-entrypoint-smoke",
    );
  }
  requireEnvDoesNotExposeSecret(
    errors,
    "hermes-root-entrypoint-smoke job",
    jobEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );
  requireEnvDoesNotExposeSecret(
    errors,
    "hermes-root-entrypoint-smoke job",
    jobEnv,
    "DOCKERHUB_USERNAME",
  );
  requireEnvDoesNotExposeSecret(
    errors,
    "hermes-root-entrypoint-smoke job",
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
      `hermes-root-entrypoint-smoke step '${stepName}'`,
      stepEnv,
      "NVIDIA_INFERENCE_API_KEY",
    );
    if (step.name !== DOCKER_HUB_AUTH_STEP) {
      requireEnvDoesNotExposeSecret(
        errors,
        `hermes-root-entrypoint-smoke step '${stepName}'`,
        stepEnv,
        "DOCKERHUB_USERNAME",
      );
      requireEnvDoesNotExposeSecret(
        errors,
        `hermes-root-entrypoint-smoke step '${stepName}'`,
        stepEnv,
        "DOCKERHUB_TOKEN",
      );
      requireNoDockerHubAuthInRun(
        errors,
        `hermes-root-entrypoint-smoke step '${stepName}'`,
        stringValue(step.run),
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("hermes-root-entrypoint-smoke job missing checkout step");
  requireFullShaAction(errors, checkout, "hermes-root-entrypoint-smoke checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("hermes-root-entrypoint-smoke checkout step must set persist-credentials=false");
  }

  const runVitest = requireJobStep(
    errors,
    jobName,
    steps,
    "Run Hermes root entrypoint smoke live test",
  );
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/hermes-root-entrypoint-smoke.test.ts");
  requireRunDoesNotContain(errors, runVitest, "${{ inputs.");
}

function validateHermesSandboxSecretBoundaryJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "hermes-sandbox-secret-boundary";
  const targetName = "hermes-sandbox-secret-boundary";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing hermes-sandbox-secret-boundary job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("hermes-sandbox-secret-boundary job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);
  if (job["timeout-minutes"] !== 60) {
    errors.push("hermes-sandbox-secret-boundary job must keep the 60 minute timeout");
  }

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("hermes-sandbox-secret-boundary job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !==
    "${{ github.workspace }}/e2e-artifacts/live/hermes-sandbox-secret-boundary"
  ) {
    errors.push(
      "hermes-sandbox-secret-boundary job must write artifacts under e2e-artifacts/live/hermes-sandbox-secret-boundary",
    );
  }
  for (const secret of ["NVIDIA_INFERENCE_API_KEY", "DOCKERHUB_USERNAME", "DOCKERHUB_TOKEN"]) {
    requireEnvDoesNotExposeSecret(errors, "hermes-sandbox-secret-boundary job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `hermes-sandbox-secret-boundary step '${
      step.name ?? step.uses ?? "<unnamed>"
    }'`;
    const stepEnv = asRecord(step.env);
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
    if (step.name !== DOCKER_HUB_AUTH_STEP) {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("hermes-sandbox-secret-boundary job missing checkout step");
  requireFullShaAction(errors, checkout, "hermes-sandbox-secret-boundary checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("hermes-sandbox-secret-boundary checkout step must set persist-credentials=false");
  }

  const runVitest = requireJobStep(
    errors,
    jobName,
    steps,
    "Run Hermes sandbox secret-boundary live test",
  );
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/hermes-sandbox-secret-boundary.test.ts");
  requireRunDoesNotContain(errors, runVitest, "${{ inputs.");
}

function validateDiagnosticsJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "diagnostics";
  const targetName = "diagnostics";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing diagnostics job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("diagnostics job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);
  if (job["timeout-minutes"] !== 60) {
    errors.push("diagnostics job must keep the 60 minute timeout");
  }

  const jobEnv = asRecord(job.env);
  if ("DOCKER_CONFIG" in jobEnv) {
    errors.push("diagnostics job must not expose Docker auth to branch-controlled steps");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/diagnostics") {
    errors.push("diagnostics job must write artifacts under e2e-artifacts/live/diagnostics");
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("diagnostics job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("diagnostics job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.NEMOCLAW_NON_INTERACTIVE !== "1") {
    errors.push("diagnostics job must set NEMOCLAW_NON_INTERACTIVE=1");
  }
  if (jobEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    errors.push("diagnostics job must set NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-diag") {
    errors.push("diagnostics job must use the stable e2e-diag sandbox name");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("diagnostics job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  for (const secret of [
    "NVIDIA_INFERENCE_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(errors, "diagnostics job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `diagnostics step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run diagnostics live test") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
    }
    if (step.name !== DOCKER_HUB_AUTH_STEP) {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "GITHUB_TOKEN");
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("diagnostics job missing checkout step");
  requireFullShaAction(errors, checkout, "diagnostics checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("diagnostics checkout step must set persist-credentials=false");
  }

  const runVitest = requireJobStep(errors, jobName, steps, "Run diagnostics live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("diagnostics live E2E step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/diagnostics.test.ts");
  requireRunDoesNotContain(errors, runVitest, "${{ inputs.");
}

function validateSparkInstallJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "spark-install";
  const targetName = "spark-install";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing spark-install job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("spark-install job must run on ubuntu-latest");
  }
  if (job["timeout-minutes"] !== 45) {
    errors.push("spark-install job must keep a 45 minute timeout");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);

  const jobEnv = asRecord(job.env);
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/spark-install") {
    errors.push("spark-install job must write artifacts under e2e-artifacts/live/spark-install");
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("spark-install job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("spark-install job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.NEMOCLAW_NON_INTERACTIVE !== "1") {
    errors.push("spark-install job must set NEMOCLAW_NON_INTERACTIVE=1");
  }
  if (jobEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    errors.push("spark-install job must accept third-party software non-interactively");
  }
  if (jobEnv.NEMOCLAW_FRESH !== "1") {
    errors.push("spark-install job must set NEMOCLAW_FRESH=1");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-spark-install-ci") {
    errors.push("spark-install job must use the stable e2e-spark-install-ci sandbox name");
  }
  if (jobEnv.NEMOCLAW_PROVIDER !== "cloud") {
    errors.push("spark-install job must use the cloud provider");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("spark-install job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  for (const secret of COMMON_SECRET_ENV_NAMES) {
    requireEnvDoesNotExposeSecret(errors, "spark-install job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `spark-install step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run Spark install live test") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
    }
    if (step.name !== DOCKER_HUB_AUTH_STEP) {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
    }
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "GITHUB_TOKEN");
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) {
    errors.push("spark-install job missing checkout step");
  }
  requireFullShaAction(errors, checkout, "spark-install checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("spark-install checkout step must set persist-credentials=false");
  }

  const runVitest = requireJobStep(errors, jobName, steps, "Run Spark install live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("spark-install live E2E step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "set -euo pipefail");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/spark-install.test.ts");
}

function validateSnapshotCommandsJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "snapshot-commands";
  const targetName = "snapshot-commands";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing snapshot-commands job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("snapshot-commands job must run on ubuntu-latest");
  }
  if (job["timeout-minutes"] !== 40) {
    errors.push("snapshot-commands job must keep a 40 minute timeout");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);

  const jobEnv = asRecord(job.env);
  if ("DOCKER_CONFIG" in jobEnv) {
    errors.push("snapshot-commands job must not set DOCKER_CONFIG at job level");
  }
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/snapshot-commands") {
    errors.push(
      "snapshot-commands job must write artifacts under e2e-artifacts/live/snapshot-commands",
    );
  }
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("snapshot-commands job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.NEMOCLAW_NON_INTERACTIVE !== "1") {
    errors.push("snapshot-commands job must set NEMOCLAW_NON_INTERACTIVE=1");
  }
  if (jobEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    errors.push("snapshot-commands job must accept third-party software non-interactively");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-snapshot") {
    errors.push("snapshot-commands job must use the stable e2e-snapshot sandbox name");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("snapshot-commands job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  for (const secret of [
    "NVIDIA_INFERENCE_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(errors, "snapshot-commands job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `snapshot-commands step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run snapshot commands live test") {
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
    errors.push("snapshot-commands job missing checkout step");
  }
  requireFullShaAction(errors, checkout, "snapshot-commands checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("snapshot-commands checkout step must set persist-credentials=false");
  }

  const runVitest = requireJobStep(errors, jobName, steps, "Run snapshot commands live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push(
      "snapshot-commands live E2E step must receive NVIDIA_INFERENCE_API_KEY from secrets",
    );
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/snapshot-commands.test.ts");
}

function validateModelRouterProviderRoutedInferenceJob(
  errors: string[],
  jobs: WorkflowRecord,
): void {
  const jobName = "model-router-provider-routed-inference";
  const targetName = "model-router-provider-routed-inference";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing model-router-provider-routed-inference job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("model-router-provider-routed-inference job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);

  const jobEnv = asRecord(job.env);
  if ("DOCKER_CONFIG" in jobEnv) {
    errors.push(
      "model-router-provider-routed-inference job must not set DOCKER_CONFIG at job level",
    );
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !==
    "${{ github.workspace }}/e2e-artifacts/live/model-router-provider-routed-inference"
  ) {
    errors.push(
      "model-router-provider-routed-inference job must write artifacts under e2e-artifacts/live/model-router-provider-routed-inference",
    );
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push(
      "model-router-provider-routed-inference job must point NEMOCLAW_CLI_BIN at the repo CLI",
    );
  }
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("model-router-provider-routed-inference job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("model-router-provider-routed-inference job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  for (const secret of [
    "NVIDIA_API_KEY",
    "NVIDIA_INFERENCE_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(
      errors,
      "model-router-provider-routed-inference job",
      jobEnv,
      secret,
    );
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `model-router-provider-routed-inference step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run Model Router provider-routed inference live test") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_API_KEY");
    }
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "GITHUB_TOKEN");
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) {
    errors.push("model-router-provider-routed-inference job missing checkout step");
  }
  requireFullShaAction(errors, checkout, "model-router-provider-routed-inference checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push(
      "model-router-provider-routed-inference checkout step must set persist-credentials=false",
    );
  }

  const runVitest = requireJobStep(
    errors,
    jobName,
    steps,
    "Run Model Router provider-routed inference live test",
  );
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_API_KEY !== "${{ secrets.NVIDIA_API_KEY }}") {
    errors.push(
      "model-router-provider-routed-inference live E2E step must receive NVIDIA_API_KEY from secrets",
    );
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(
    errors,
    runVitest,
    "test/e2e/live/model-router-provider-routed-inference.test.ts",
  );
}

function validateGatewayDriftPreflightJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "gateway-drift-preflight";
  const job = asRecord(jobs[jobName]);
  validateFreeStandingJobSelector(errors, jobs, jobName, "gateway-drift-preflight");
  if (Object.keys(job).length === 0) return;

  const runVitest = requireJobStep(
    errors,
    jobName,
    asSteps(job.steps),
    "Run gateway drift preflight Vitest test",
  );
  requireRunContains(errors, runVitest, "npx vitest run --project integration");
  requireRunContains(errors, runVitest, "test/gateway-drift-preflight.test.ts");
  requireRunDoesNotContain(errors, runVitest, "--project cli");
}

function runContainsCloudflaredAptInstall(run: string): boolean {
  return /apt-get\s+install[\s\S]*cloudflared|apt\s+install[\s\S]*cloudflared|pkg\.cloudflare\.com\/cloudflared/.test(
    run,
  );
}

const TUNNEL_LIFECYCLE_CLOUDFLARED_VERSION = "2026.6.1";
const TUNNEL_LIFECYCLE_CLOUDFLARED_DEB_SHA256 =
  "ccd02ec216c62bfa573395d8f72cb2e91e95cbdf8726a8acc06b3e2d9aa31526";

function validateTunnelLifecycleJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "tunnel-lifecycle";
  const targetName = "tunnel-lifecycle";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing tunnel-lifecycle job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("tunnel-lifecycle job must run on ubuntu-latest");
  }
  if (job["timeout-minutes"] !== 75) {
    errors.push("tunnel-lifecycle job must keep the 75 minute timeout");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);

  const jobEnv = asRecord(job.env);
  if ("DOCKER_CONFIG" in jobEnv) {
    errors.push("tunnel-lifecycle job must not set DOCKER_CONFIG at job level");
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("tunnel-lifecycle job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.E2E_JOB !== "1") {
    errors.push("tunnel-lifecycle job must set E2E_JOB=1");
  }
  if (jobEnv.E2E_TARGET_ID !== targetName) {
    errors.push(`tunnel-lifecycle job must set E2E_TARGET_ID=${targetName}`);
  }
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("tunnel-lifecycle job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  requireEnvDoesNotExposeSecret(errors, "tunnel-lifecycle job", jobEnv, "NVIDIA_INFERENCE_API_KEY");

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `tunnel-lifecycle step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "GITHUB_TOKEN");
    if (step.name !== "Run tunnel lifecycle live test") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_API_KEY");
    }
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) {
    errors.push("tunnel-lifecycle job missing checkout step");
  }
  requireFullShaAction(errors, checkout, "tunnel-lifecycle checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("tunnel-lifecycle checkout step must set persist-credentials=false");
  }

  const cloudflaredPrereq = requireJobStep(
    errors,
    jobName,
    steps,
    "Install and verify cloudflared prerequisite",
  );
  const cloudflaredPrereqEnv = asRecord(cloudflaredPrereq?.env);
  requireEnvDoesNotExposeSecret(
    errors,
    "tunnel-lifecycle cloudflared prerequisite step",
    cloudflaredPrereqEnv,
    "NVIDIA_API_KEY",
  );
  requireEnvDoesNotExposeSecret(
    errors,
    "tunnel-lifecycle cloudflared prerequisite step",
    cloudflaredPrereqEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );
  requireRunContains(errors, cloudflaredPrereq, "cloudflared --version");
  if (cloudflaredPrereqEnv.CLOUDFLARED_VERSION !== TUNNEL_LIFECYCLE_CLOUDFLARED_VERSION) {
    errors.push(
      `tunnel-lifecycle cloudflared prerequisite step must pin CLOUDFLARED_VERSION=${TUNNEL_LIFECYCLE_CLOUDFLARED_VERSION}`,
    );
  }
  if (cloudflaredPrereqEnv.CLOUDFLARED_DEB_SHA256 !== TUNNEL_LIFECYCLE_CLOUDFLARED_DEB_SHA256) {
    errors.push(
      `tunnel-lifecycle cloudflared prerequisite step must pin CLOUDFLARED_DEB_SHA256=${TUNNEL_LIFECYCLE_CLOUDFLARED_DEB_SHA256}`,
    );
  }
  requireRunContains(
    errors,
    cloudflaredPrereq,
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb",
  );
  requireRunContains(errors, cloudflaredPrereq, "sha256sum -c -");
  requireRunContains(errors, cloudflaredPrereq, "dpkg-deb -f");
  requireRunContains(errors, cloudflaredPrereq, "sudo dpkg -i");
  requireRunContains(errors, cloudflaredPrereq, "cloudflared version ${CLOUDFLARED_VERSION}");
  requireRunDoesNotContain(errors, cloudflaredPrereq, "pkg.cloudflare.com");
  requireRunDoesNotContain(errors, cloudflaredPrereq, "cloudflare-main.gpg");
  requireRunDoesNotContain(errors, cloudflaredPrereq, "apt-cache madison");
  requireRunDoesNotContain(errors, cloudflaredPrereq, "apt-get install");
  requireRunDoesNotContain(errors, cloudflaredPrereq, "cloudflared_resolve_package_version");

  const runVitest = requireJobStep(errors, jobName, steps, "Run tunnel lifecycle live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push(
      "tunnel-lifecycle live E2E step must receive NVIDIA_INFERENCE_API_KEY from secrets",
    );
  }
  if (runContainsCloudflaredAptInstall(stringValue(runVitest?.run))) {
    errors.push(
      "tunnel-lifecycle live E2E step must not run cloudflared APT installation with NVIDIA_INFERENCE_API_KEY in scope",
    );
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/tunnel-lifecycle.test.ts");
}

function validateIssue2478CrashLoopRecoveryJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "issue-2478-crash-loop-recovery";
  const targetName = "issue-2478-crash-loop-recovery";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing issue-2478-crash-loop-recovery job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("issue-2478-crash-loop-recovery job must run on ubuntu-latest");
  }
  if (job["timeout-minutes"] !== 30) {
    errors.push("issue-2478-crash-loop-recovery job must keep the 30 minute timeout");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);

  const jobEnv = asRecord(job.env);
  if ("DOCKER_CONFIG" in jobEnv) {
    errors.push("issue-2478-crash-loop-recovery job must not set DOCKER_CONFIG at job level");
  }
  const expectedEnv: Record<string, string> = {
    E2E_JOB: "1",
    E2E_TARGET_ID: targetName,
    E2E_ARTIFACT_DIR: "${{ github.workspace }}/e2e-artifacts/live/issue-2478-crash-loop-recovery",
    NEMOCLAW_CLI_BIN: "${{ github.workspace }}/bin/nemoclaw.js",
    NEMOCLAW_RUN_LIVE_E2E: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SANDBOX_NAME: "e2e-2478",
    OPENSHELL_GATEWAY: "nemoclaw",
  };
  for (const [key, value] of Object.entries(expectedEnv)) {
    if (jobEnv[key] !== value) {
      errors.push(`issue-2478-crash-loop-recovery job env ${key} must be ${value}`);
    }
  }
  for (const secret of [...COMMON_SECRET_ENV_NAMES]) {
    requireEnvDoesNotExposeSecret(errors, "issue-2478-crash-loop-recovery job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `issue-2478-crash-loop-recovery step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "GITHUB_TOKEN");
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) {
    errors.push("issue-2478-crash-loop-recovery job missing checkout step");
  }
  requireFullShaAction(errors, checkout, "issue-2478-crash-loop-recovery checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("issue-2478-crash-loop-recovery checkout step must set persist-credentials=false");
  }

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
    "issue-2478-crash-loop-recovery live E2E step",
    runVitestEnv,
    "NVIDIA_INFERENCE_API_KEY",
  );
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/issue-2478-crash-loop-recovery.test.ts");
}

function validateChannelsAddRemoveJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "channels-add-remove";
  const targetName = "channels-add-remove";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing channels-add-remove job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("channels-add-remove job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);
  if (job["timeout-minutes"] !== 75) {
    errors.push("channels-add-remove job must keep the legacy 75 minute timeout");
  }
  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("channels-add-remove job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/channels-add-remove"
  ) {
    errors.push(
      "channels-add-remove job must write artifacts under e2e-artifacts/live/channels-add-remove",
    );
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("channels-add-remove job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-channels-add-remove") {
    errors.push("channels-add-remove job must set NEMOCLAW_SANDBOX_NAME=e2e-channels-add-remove");
  }
  if (jobEnv.NEMOCLAW_NON_INTERACTIVE !== "1") {
    errors.push("channels-add-remove job must set NEMOCLAW_NON_INTERACTIVE=1");
  }
  if (jobEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    errors.push("channels-add-remove job must set NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("channels-add-remove job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  if (jobEnv.NEMOCLAW_E2E_USE_HOSTED_INFERENCE !== "1") {
    errors.push("channels-add-remove job must enable hosted-compatible inference mode");
  }
  if (jobEnv.NEMOCLAW_PROVIDER !== "custom") {
    errors.push("channels-add-remove job must route hosted inference through the custom provider");
  }
  if (jobEnv.NEMOCLAW_ENDPOINT_URL !== "https://inference-api.nvidia.com/v1") {
    errors.push("channels-add-remove job must use the hosted compatible inference endpoint");
  }
  if (jobEnv.NEMOCLAW_MODEL !== "nvidia/nvidia/nemotron-3-ultra") {
    errors.push("channels-add-remove job must use the hosted Inference Hub model id");
  }
  if (jobEnv.NEMOCLAW_COMPAT_MODEL !== "nvidia/nvidia/nemotron-3-ultra") {
    errors.push("channels-add-remove job must set NEMOCLAW_COMPAT_MODEL to the hosted model id");
  }
  if (jobEnv.NEMOCLAW_PREFERRED_API !== "openai-completions") {
    errors.push("channels-add-remove job must prefer openai-completions for hosted inference");
  }
  for (const secret of [
    "NVIDIA_INFERENCE_API_KEY",
    "COMPATIBLE_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(errors, "channels-add-remove job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `channels-add-remove step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run channels add/remove live test") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "COMPATIBLE_API_KEY");
    }
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "GITHUB_TOKEN");
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("channels-add-remove job missing checkout step");
  requireFullShaAction(errors, checkout, "channels-add-remove checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("channels-add-remove checkout step must set persist-credentials=false");
  }

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");
  requireRunContains(errors, installOpenShell, "env -u DOCKER_CONFIG");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_USERNAME");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_TOKEN");
  requireRunContains(errors, installOpenShell, "-u NVIDIA_INFERENCE_API_KEY");
  requireRunContains(errors, installOpenShell, "-u GITHUB_TOKEN");

  const runVitest = requireJobStep(errors, jobName, steps, "Run channels add/remove live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("channels-add-remove step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  if (runVitestEnv.COMPATIBLE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push(
      "channels-add-remove step must stage NVIDIA_INFERENCE_API_KEY as COMPATIBLE_API_KEY",
    );
  }
  if (runVitestEnv.TELEGRAM_BOT_TOKEN !== "test-fake-telegram-token-add-remove-e2e") {
    errors.push("channels-add-remove step must set the fake Telegram token");
  }
  if (runVitestEnv.TELEGRAM_ALLOWED_IDS !== "123456789") {
    errors.push("channels-add-remove step must set TELEGRAM_ALLOWED_IDS");
  }
  if (runVitestEnv.TELEGRAM_REQUIRE_MENTION !== "0") {
    errors.push("channels-add-remove step must set TELEGRAM_REQUIRE_MENTION");
  }
  requireRunContains(errors, runVitest, "OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/channels-add-remove.test.ts");
}

function validateOpenClawDiscordPairingJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "openclaw-discord-pairing";
  const targetName = "openclaw-discord-pairing";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing openclaw-discord-pairing job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("openclaw-discord-pairing job must run on ubuntu-latest");
  }
  if (job["timeout-minutes"] !== 60) {
    errors.push("openclaw-discord-pairing job must keep the 60 minute timeout");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);

  const jobEnv = asRecord(job.env);
  if ("DOCKER_CONFIG" in jobEnv) {
    errors.push("openclaw-discord-pairing job must not set DOCKER_CONFIG at job level");
  }
  for (const secret of [...COMMON_SECRET_ENV_NAMES]) {
    requireEnvDoesNotExposeSecret(errors, "openclaw-discord-pairing job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `openclaw-discord-pairing step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run OpenClaw Discord pairing live test") {
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
  if (!checkout) errors.push("openclaw-discord-pairing job missing checkout step");
  requireFullShaAction(errors, checkout, "openclaw-discord-pairing checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("openclaw-discord-pairing checkout step must set persist-credentials=false");
  }

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell CLI");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");
  requireRunContains(errors, installOpenShell, "env -u DOCKER_CONFIG");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_USERNAME");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_TOKEN");
  requireRunContains(errors, installOpenShell, "-u NVIDIA_INFERENCE_API_KEY");
  requireRunContains(errors, installOpenShell, "-u GITHUB_TOKEN");

  const runVitest = requireJobStep(
    errors,
    jobName,
    steps,
    "Run OpenClaw Discord pairing live test",
  );
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("openclaw-discord-pairing step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  if (runVitestEnv.DISCORD_BOT_TOKEN !== "test-fake-discord-pairing-e2e") {
    errors.push("openclaw-discord-pairing step must use fake Discord token");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/openclaw-discord-pairing.test.ts");
}

function validateOpenClawSlackPairingJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "openclaw-slack-pairing";
  const targetName = "openclaw-slack-pairing";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing openclaw-slack-pairing job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("openclaw-slack-pairing job must run on ubuntu-latest");
  }
  if (job["timeout-minutes"] !== 60) {
    errors.push("openclaw-slack-pairing job must keep the 60 minute timeout");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);

  const jobEnv = asRecord(job.env);
  if ("DOCKER_CONFIG" in jobEnv) {
    errors.push("openclaw-slack-pairing job must not set DOCKER_CONFIG at job level");
  }
  for (const secret of [...COMMON_SECRET_ENV_NAMES]) {
    requireEnvDoesNotExposeSecret(errors, "openclaw-slack-pairing job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `openclaw-slack-pairing step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run OpenClaw Slack pairing live test") {
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
  if (!checkout) errors.push("openclaw-slack-pairing job missing checkout step");
  requireFullShaAction(errors, checkout, "openclaw-slack-pairing checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("openclaw-slack-pairing checkout step must set persist-credentials=false");
  }

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell CLI");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");
  requireRunContains(errors, installOpenShell, "env -u DOCKER_CONFIG");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_USERNAME");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_TOKEN");
  requireRunContains(errors, installOpenShell, "-u NVIDIA_INFERENCE_API_KEY");
  requireRunContains(errors, installOpenShell, "-u GITHUB_TOKEN");

  const runVitest = requireJobStep(errors, jobName, steps, "Run OpenClaw Slack pairing live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("openclaw-slack-pairing step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  if (runVitestEnv.SLACK_BOT_TOKEN !== "xoxb-fake-slack-pairing-e2e") {
    errors.push("openclaw-slack-pairing step must use fake Slack bot token");
  }
  if (runVitestEnv.SLACK_APP_TOKEN !== "xapp-fake-slack-pairing-e2e") {
    errors.push("openclaw-slack-pairing step must use fake Slack app token");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/openclaw-slack-pairing.test.ts");
}

function validateChannelsStopStartJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "channels-stop-start";
  const targetName = "channels-stop-start";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing channels-stop-start job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("channels-stop-start job must run on ubuntu-latest");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);
  if (job["timeout-minutes"] !== 90) {
    errors.push("channels-stop-start job must keep the 90 minute timeout");
  }
  const strategy = asRecord(job.strategy);
  if (strategy["fail-fast"] !== false) {
    errors.push("channels-stop-start strategy.fail-fast must be false");
  }
  const matrix = asRecord(strategy.matrix);
  if (!Array.isArray(matrix.agent) || matrix.agent.join(",") !== "openclaw,hermes") {
    errors.push("channels-stop-start matrix.agent must be openclaw,hermes");
  }

  const jobEnv = asRecord(job.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("channels-stop-start job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !==
    "${{ github.workspace }}/e2e-artifacts/live/channels-stop-start/${{ matrix.agent }}"
  ) {
    errors.push(
      "channels-stop-start job must write artifacts under e2e-artifacts/live/channels-stop-start/${{ matrix.agent }}",
    );
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push("channels-stop-start job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-channels-stop-start-${{ matrix.agent }}") {
    errors.push(
      "channels-stop-start job must derive NEMOCLAW_SANDBOX_NAME from matrix.agent with the e2e-channels-stop-start- prefix",
    );
  }
  if (jobEnv.NEMOCLAW_AGENT !== "${{ matrix.agent }}") {
    errors.push("channels-stop-start job must pass matrix.agent through NEMOCLAW_AGENT");
  }
  if (jobEnv.NEMOCLAW_CHANNELS_STOP_START_AGENT !== "${{ matrix.agent }}") {
    errors.push(
      "channels-stop-start job must pass matrix.agent through NEMOCLAW_CHANNELS_STOP_START_AGENT",
    );
  }
  if (jobEnv.NEMOCLAW_NON_INTERACTIVE !== "1") {
    errors.push("channels-stop-start job must set NEMOCLAW_NON_INTERACTIVE=1");
  }
  if (jobEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    errors.push("channels-stop-start job must set NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("channels-stop-start job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  for (const secret of [
    "NVIDIA_INFERENCE_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(errors, "channels-stop-start job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `channels-stop-start step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run channels stop/start live test") {
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
  if (!checkout) errors.push("channels-stop-start job missing checkout step");
  requireFullShaAction(errors, checkout, "channels-stop-start checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("channels-stop-start checkout step must set persist-credentials=false");
  }

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");
  requireRunContains(errors, installOpenShell, "env -u DOCKER_CONFIG");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_USERNAME");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_TOKEN");
  requireRunContains(errors, installOpenShell, "-u NVIDIA_INFERENCE_API_KEY");
  requireRunContains(errors, installOpenShell, "-u GITHUB_TOKEN");

  const runVitest = requireJobStep(errors, jobName, steps, "Run channels stop/start live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("channels-stop-start step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  if (
    runVitestEnv.TELEGRAM_BOT_TOKEN !== "test-fake-telegram-token-stop-start-${{ matrix.agent }}"
  ) {
    errors.push("channels-stop-start step must set the fake Telegram token");
  }
  if (runVitestEnv.DISCORD_BOT_TOKEN !== "test-fake-discord-token-stop-start-${{ matrix.agent }}") {
    errors.push("channels-stop-start step must set the fake Discord token");
  }
  if (runVitestEnv.SLACK_BOT_TOKEN !== "xoxb-fake-slack-token-stop-start-${{ matrix.agent }}") {
    errors.push("channels-stop-start step must set the fake Slack bot token");
  }
  if (runVitestEnv.SLACK_APP_TOKEN !== "xapp-fake-slack-token-stop-start-${{ matrix.agent }}") {
    errors.push("channels-stop-start step must set the fake Slack app token");
  }
  if (runVitestEnv.WECHAT_BOT_TOKEN !== "test-fake-wechat-token-stop-start-${{ matrix.agent }}") {
    errors.push("channels-stop-start step must set the fake WeChat token");
  }
  requireRunContains(errors, runVitest, "OPENSHELL_BIN");
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/channels-stop-start.test.ts");
}

function validateTelegramInjectionJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "telegram-injection";
  const targetName = "telegram-injection";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing telegram-injection job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("telegram-injection job must run on ubuntu-latest");
  }
  if (job["timeout-minutes"] !== 45) {
    errors.push("telegram-injection job must keep the 45 minute timeout");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);

  const jobEnv = asRecord(job.env);
  if ("DOCKER_CONFIG" in jobEnv) {
    errors.push("telegram-injection job must not set DOCKER_CONFIG at job level");
  }
  for (const secret of [...COMMON_SECRET_ENV_NAMES]) {
    requireEnvDoesNotExposeSecret(errors, "telegram-injection job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `telegram-injection step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    if (step.name !== "Run Telegram injection live test") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
    }
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "GITHUB_TOKEN");
  }

  const installOpenShell = requireJobStep(errors, jobName, steps, "Install OpenShell");
  requireRunContains(errors, installOpenShell, "bash scripts/install-openshell.sh");
  requireRunContains(errors, installOpenShell, "env -u DOCKER_CONFIG");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_USERNAME");
  requireRunContains(errors, installOpenShell, "-u DOCKERHUB_TOKEN");
  requireRunContains(errors, installOpenShell, "-u NVIDIA_INFERENCE_API_KEY");
  requireRunContains(errors, installOpenShell, "-u GITHUB_TOKEN");

  const runVitest = requireJobStep(errors, jobName, steps, "Run Telegram injection live test");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("telegram-injection step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/telegram-injection.test.ts");
}

function validateBedrockRuntimeCompatibleAnthropicJob(
  errors: string[],
  jobs: WorkflowRecord,
): void {
  const jobName = "bedrock-runtime-compatible-anthropic";
  const targetName = "bedrock-runtime-compatible-anthropic";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing bedrock-runtime-compatible-anthropic job");
    return;
  }

  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("bedrock-runtime-compatible-anthropic job must run on ubuntu-latest");
  }
  if (job["timeout-minutes"] !== 60) {
    errors.push("bedrock-runtime-compatible-anthropic timeout-minutes must be 60");
  }
  validateFreeStandingJobSelector(errors, jobs, jobName, targetName);

  const strategy = asRecord(job.strategy);
  if (strategy["fail-fast"] !== false) {
    errors.push("bedrock-runtime-compatible-anthropic strategy.fail-fast must be false");
  }
  const matrix = asRecord(strategy.matrix);
  if (!Array.isArray(matrix.agent) || matrix.agent.join(",") !== "openclaw,hermes") {
    errors.push("bedrock-runtime-compatible-anthropic matrix.agent must be openclaw,hermes");
  }

  const jobEnv = asRecord(job.env);
  if ("DOCKER_CONFIG" in jobEnv) {
    errors.push("bedrock-runtime-compatible-anthropic job must not set DOCKER_CONFIG at job level");
  }
  if (
    jobEnv.E2E_ARTIFACT_DIR !==
    "${{ github.workspace }}/e2e-artifacts/live/bedrock-runtime-compatible-anthropic/${{ matrix.agent }}"
  ) {
    errors.push(
      "bedrock-runtime-compatible-anthropic job must write artifacts under e2e-artifacts/live/bedrock-runtime-compatible-anthropic/${{ matrix.agent }}",
    );
  }
  if (jobEnv.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push(
      "bedrock-runtime-compatible-anthropic job must point NEMOCLAW_CLI_BIN at the repo CLI",
    );
  }
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("bedrock-runtime-compatible-anthropic job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (jobEnv.NEMOCLAW_NON_INTERACTIVE !== "1") {
    errors.push("bedrock-runtime-compatible-anthropic job must set NEMOCLAW_NON_INTERACTIVE=1");
  }
  if (jobEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    errors.push(
      "bedrock-runtime-compatible-anthropic job must set NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1",
    );
  }
  if (jobEnv.NEMOCLAW_RECREATE_SANDBOX !== "1") {
    errors.push("bedrock-runtime-compatible-anthropic job must set NEMOCLAW_RECREATE_SANDBOX=1");
  }
  if (jobEnv.NEMOCLAW_AGENT !== "${{ matrix.agent }}") {
    errors.push(
      "bedrock-runtime-compatible-anthropic job must pass matrix.agent through NEMOCLAW_AGENT",
    );
  }
  if (jobEnv.NEMOCLAW_SANDBOX_NAME !== "e2e-bedrock-${{ matrix.agent }}") {
    errors.push(
      "bedrock-runtime-compatible-anthropic job must derive NEMOCLAW_SANDBOX_NAME from matrix.agent",
    );
  }
  if (jobEnv.OPENSHELL_GATEWAY !== "nemoclaw") {
    errors.push("bedrock-runtime-compatible-anthropic job must force OPENSHELL_GATEWAY=nemoclaw");
  }
  for (const secret of [
    "NVIDIA_INFERENCE_API_KEY",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    requireEnvDoesNotExposeSecret(
      errors,
      "bedrock-runtime-compatible-anthropic job",
      jobEnv,
      secret,
    );
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    const stepName = `bedrock-runtime-compatible-anthropic step '${step.name ?? step.uses ?? "<unnamed>"}'`;
    const stepEnv = asRecord(step.env);
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "GITHUB_TOKEN");
    if (step.name !== "Authenticate to Docker Hub") {
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_USERNAME");
      requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "DOCKERHUB_TOKEN");
      requireNoDockerHubAuthInRun(errors, stepName, stringValue(step.run));
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) {
    errors.push("bedrock-runtime-compatible-anthropic job missing checkout step");
  }
  requireFullShaAction(errors, checkout, "bedrock-runtime-compatible-anthropic checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push(
      "bedrock-runtime-compatible-anthropic checkout step must set persist-credentials=false",
    );
  }

  const runVitest = requireJobStep(
    errors,
    jobName,
    steps,
    "Run Bedrock Runtime compatible Anthropic live test",
  );
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(
    errors,
    runVitest,
    "test/e2e/live/bedrock-runtime-compatible-anthropic.test.ts",
  );
  requireRunDoesNotContain(errors, runVitest, "${{ inputs.");
}

export function validateE2eWorkflowBoundary(workflowPath = DEFAULT_E2E_WORKFLOW_PATH): string[] {
  const workflow = readWorkflowRecord(workflowPath);
  const errors: string[] = [];
  errors.push(...validatePrepareE2eWorkflowBoundary(workflow));
  errors.push(...validateUploadE2eArtifactsWorkflowBoundary(workflow));
  errors.push(...validateHermesDashboardWorkflowBoundary(workflowPath));
  errors.push(...validateHermesGpuStartupWorkflowBoundary(workflowPath));
  errors.push(...validateInferenceSwitchWorkflowBoundary(workflowPath));
  errors.push(...validateE2eOperationsWorkflowBoundary(workflowPath));
  errors.push(...validateDocsValidationWorkflowBoundary(workflowPath));
  errors.push(...validateSecurityPostureWorkflowBoundary(workflowPath));
  const triggers = asRecord(workflow.on ?? workflow[true as unknown as string]);

  const workflowDispatch = requireWorkflowDispatch(errors, triggers);
  requireScheduledRun(errors, triggers);
  rejectUnexpectedTriggers(errors, triggers);

  const dispatchInputs = asRecord(workflowDispatch.inputs);
  requireInput(errors, dispatchInputs, "targets");
  const jobsInput = requireInput(errors, dispatchInputs, "jobs");
  const jobsDescription = stringValue(jobsInput.description);
  if (!jobsDescription.includes("default-enabled jobs")) {
    errors.push(
      "workflow_dispatch jobs input description must say empty dispatch runs default-enabled jobs",
    );
  }
  if (!jobsDescription.includes("explicit-only jobs")) {
    errors.push(
      "workflow_dispatch jobs input description must say explicit-only jobs are skipped unless selected",
    );
  }
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
  validateDockerHubAuthBoundary(errors, jobs);
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
  if (generateOutputs.explicit_only_jobs !== "${{ steps.matrix.outputs.explicit_only_jobs }}") {
    errors.push("generate-matrix job must expose explicit_only_jobs output");
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
  const generate = requireStep(errors, generateSteps, "Generate E2E target matrix");
  const generateEnv = asRecord(generate?.env);
  if (generateEnv.JOBS !== "${{ inputs.jobs }}") {
    errors.push("matrix generation step must pass jobs through JOBS env");
  }
  if (generateEnv.TARGETS !== "${{ inputs.targets }}") {
    errors.push("matrix generation step must pass targets through TARGETS env");
  }
  requireRunContains(errors, generate, FREE_STANDING_WORKFLOW_INVENTORY_SCRIPT);
  requireRunContains(
    errors,
    generate,
    "free-standing workflow inventory must be data-only key=value",
  );
  requireRunContains(errors, generate, "free_standing_targets_csv must match target mapping keys");
  requireRunContains(errors, generate, "Free-standing target maps to unknown job");
  requireRunContains(errors, generate, "Use either targets or jobs, not both");
  requireRunContains(errors, generate, "Unknown free-standing E2E job");
  requireRunContains(errors, generate, 'matrix="[]"');
  requireRunContains(errors, generate, "npx tsx test/e2e/registry/run.ts");
  requireRunContains(errors, generate, "--emit-live-matrix");
  requireRunContains(errors, generate, "--targets");
  requireRunContains(errors, generate, "^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$");
  requireRunContains(errors, generate, "Invalid target input; use comma-separated target ids");
  requireRunContains(errors, generate, "Invalid jobs input; use comma-separated job ids");
  requireRunDoesNotContain(errors, generate, "Invalid jobs input: ${JOBS}");
  requireRunDoesNotContain(errors, generate, "Invalid target input: ${TARGETS}");
  requireRunDoesNotContain(errors, generate, "^[A-Za-z0-9._-]+");
  requireRunContains(errors, generate, "hermes_selected=false");
  requireRunContains(errors, generate, "hermes_selected=true");
  requireRunContains(
    errors,
    generate,
    'echo "hermes_selected=${hermes_selected}" >> "$GITHUB_OUTPUT"',
  );
  requireRunContains(
    errors,
    generate,
    'echo "explicit_only_jobs=${explicit_only_jobs_csv}" >> "$GITHUB_OUTPUT"',
  );
  requireRunContains(errors, generate, "## E2E Target Matrix");
  requireRunContains(errors, generate, "| Target | Runner | Label |");

  const liveTargets = asRecord(jobs["live"]);
  if (Object.keys(liveTargets).length === 0) errors.push("workflow missing live job");
  if (liveTargets["runs-on"] !== "${{ matrix.runner }}") {
    errors.push("live job must run on the matrix runner");
  }
  if (liveTargets.needs !== "generate-matrix") {
    errors.push("live job must depend on generate-matrix");
  }
  if (
    liveTargets.if !==
    "${{ (github.event_name != 'workflow_dispatch' || inputs.jobs == '') && needs.generate-matrix.outputs.matrix != '[]' }}"
  ) {
    errors.push("live job must not run when a free-standing jobs selector is supplied");
  }
  const strategy = asRecord(liveTargets.strategy);
  if (strategy["fail-fast"] !== false) {
    errors.push("live strategy.fail-fast must be false");
  }
  const matrix = asRecord(strategy.matrix);
  if (matrix.include !== "${{ fromJSON(needs.generate-matrix.outputs.matrix) }}") {
    errors.push("live matrix.include must come from generate-matrix output");
  }

  const jobEnv = asRecord(liveTargets.env);
  if (jobEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("live job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  validateHostedCompatibleInferenceFlag(errors, "live", jobEnv);
  if (!stringValue(jobEnv.E2E_ARTIFACT_DIR).includes("e2e-artifacts/live")) {
    errors.push("live job must write artifacts under e2e-artifacts/live");
  }
  if (stringValue(jobEnv.E2E_ARTIFACT_DIR).includes("${{ matrix.id }}")) {
    errors.push("live job E2E_ARTIFACT_DIR must be the Vitest artifact parent");
  }
  if (!stringValue(jobEnv.NEMOCLAW_CLI_BIN).includes("bin/nemoclaw.js")) {
    errors.push("live job must point NEMOCLAW_CLI_BIN at the repo CLI");
  }
  requireEnvDoesNotExposeSecret(errors, "live job", jobEnv, "NVIDIA_INFERENCE_API_KEY");

  const steps = asSteps(liveTargets.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    if (step.name !== "Run live E2E tests") {
      requireEnvDoesNotExposeSecret(
        errors,
        `step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        "NVIDIA_INFERENCE_API_KEY",
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("live job missing checkout step");
  requireFullShaAction(errors, checkout, "checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("checkout step must set persist-credentials=false");
  }

  const runVitest = requireStep(errors, steps, "Run live E2E tests");
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.TARGET_ID !== "${{ matrix.id }}") {
    errors.push("live E2E step must pass matrix.id through TARGET_ID env");
  }
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("live E2E step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "npx vitest run --project e2e-live");
  requireRunContains(errors, runVitest, "test/e2e/live/registry-targets.test.ts");
  requireRunContains(errors, runVitest, '"^${TARGET_ID}$"');

  const summary = requireStep(errors, steps, "Summarize artifacts");
  const summaryEnv = asRecord(summary?.env);
  if (summaryEnv.TARGET_ID !== "${{ matrix.id }}") {
    errors.push("summary step must pass matrix.id through TARGET_ID env");
  }
  if (summaryEnv.TARGET_LABEL !== "${{ matrix.label }}") {
    errors.push("summary step must pass matrix.label through TARGET_LABEL env");
  }
  requireRunContains(errors, summary, "run-plan.json");
  requireRunContains(
    errors,
    summary,
    'Path(os.environ["E2E_ARTIFACT_DIR"]) / os.environ["TARGET_ID"]',
  );
  requireRunContains(errors, summary, "| Target | Manifest | Expected state | Suites | Phases |");
  requireRunContains(errors, summary, "TARGET_ID");

  validateOpenShellVersionPinJob(errors, jobs);
  validateOnboardNegativePathsJob(errors, jobs);
  validateSkillAgentJob(errors, jobs);
  validateFreeStandingJobSelector(errors, jobs, "credential-migration", "credential-migration");
  validateFreeStandingJobSelector(errors, jobs, "sessions-agents-cli", "sessions-agents-cli");
  validateFreeStandingJobSelector(errors, jobs, "inference-routing", "inference-routing");
  validateCloudInferenceJob(errors, jobs);
  validateRuntimeOverridesJob(errors, jobs);
  validateDoubleOnboardJob(errors, jobs);
  validateHermesE2EJob(errors, jobs);
  validateFreeStandingJobSelector(errors, jobs, "hermes-discord", "hermes-discord");
  validateHermesRootEntrypointSmokeJob(errors, jobs);
  validateHermesSandboxSecretBoundaryJob(errors, jobs);
  validateNetworkPolicyJob(errors, jobs);
  validateCommonEgressAgentJob(errors, jobs);
  validateShieldsConfigJob(errors, jobs);
  validateRebuildOpenClawJob(errors, jobs);
  validateRebuildHermesJob(errors, jobs, { staleBase: false });
  validateRebuildHermesJob(errors, jobs, { staleBase: true });
  validateSandboxRebuildJob(errors, jobs);
  validateStateBackupRestoreJob(errors, jobs);
  validateUpgradeStaleSandboxJob(errors, jobs);
  validateTokenRotationJob(errors, jobs);
  validateMessagingCompatibleEndpointJob(errors, jobs);
  validateSerializedHostedAgentProofs(errors, jobs);
  validateFreeStandingJobSelector(errors, jobs, "gateway-guard-recovery", "gateway-guard-recovery");
  validateGatewayGuardRecoveryJob(errors, jobs);
  validateFreeStandingJobSelector(
    errors,
    jobs,
    "issue-4434-tui-unreachable-inference",
    "issue-4434-tui-unreachable-inference",
  );
  validateIssue4434HostDependencies(errors, jobs);
  validateDiagnosticsJob(errors, jobs);
  validateModelRouterProviderRoutedInferenceJob(errors, jobs);
  validateSnapshotCommandsJob(errors, jobs);
  errors.push(...validateSandboxOperationsWorkflow({ jobs }));
  validateSparkInstallJob(errors, jobs);
  validateGatewayDriftPreflightJob(errors, jobs);

  validateFreeStandingJobSelector(
    errors,
    jobs,
    "openclaw-inference-switch",
    "openclaw-inference-switch",
  );

  validateBedrockRuntimeCompatibleAnthropicJob(errors, jobs);

  validateIssue2478CrashLoopRecoveryJob(errors, jobs);

  validateTunnelLifecycleJob(errors, jobs);

  validateFreeStandingJobSelector(errors, jobs, "gateway-health-honest", "gateway-health-honest");

  const jetsonJob = asRecord(jobs["jetson-nvmap-gpu"]);
  if (jetsonJob.needs !== "generate-matrix") {
    errors.push("jetson-nvmap-gpu job must depend on generate-matrix");
  }
  if (jetsonJob.if !== explicitOnlyFreeStandingJobIf("jetson-nvmap-gpu", "jetson-nvmap-gpu")) {
    errors.push("jetson-nvmap-gpu job must run only when explicitly selected");
  }

  const sandboxRlimitConnectJob = asRecord(jobs["sandbox-rlimits-connect"]);
  if (sandboxRlimitConnectJob.needs !== "generate-matrix") {
    errors.push("sandbox-rlimits-connect job must depend on generate-matrix");
  }
  if (
    sandboxRlimitConnectJob.if !==
    explicitOnlyFreeStandingJobIf("sandbox-rlimits-connect", "sandbox-rlimits-connect")
  ) {
    errors.push("sandbox-rlimits-connect job must run only when explicitly selected");
  }
  const sandboxRlimitConnectEnv = asRecord(sandboxRlimitConnectJob.env);
  if (sandboxRlimitConnectEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("sandbox-rlimits-connect job must set NEMOCLAW_RUN_LIVE_E2E=1");
  }
  if (sandboxRlimitConnectEnv.NEMOCLAW_E2E_CONNECT_RLIMITS !== "1") {
    errors.push("sandbox-rlimits-connect job must opt in with NEMOCLAW_E2E_CONNECT_RLIMITS=1");
  }
  if (
    sandboxRlimitConnectEnv.E2E_ARTIFACT_DIR !==
    "${{ github.workspace }}/e2e-artifacts/live/sandbox-rlimits-connect"
  ) {
    errors.push(
      "sandbox-rlimits-connect job must write artifacts under e2e-artifacts/live/sandbox-rlimits-connect",
    );
  }
  const sandboxRlimitConnectSteps = asSteps(sandboxRlimitConnectJob.steps);
  const sandboxRlimitConnectRun = namedStep(
    sandboxRlimitConnectSteps,
    "Run sandbox rlimit connect live test",
  );
  if (!sandboxRlimitConnectRun) {
    errors.push("sandbox-rlimits-connect job missing step: Run sandbox rlimit connect live test");
  } else {
    const runScript = stringValue(sandboxRlimitConnectRun.run);
    if (!runScript.includes("test/e2e/live/sandbox-rlimits-connect.test.ts")) {
      errors.push("sandbox-rlimits-connect job must run sandbox-rlimits-connect.test.ts");
    }
    if (asRecord(sandboxRlimitConnectRun.env).NVIDIA_API_KEY !== "${{ secrets.NVIDIA_API_KEY }}") {
      errors.push("sandbox-rlimits-connect step must receive NVIDIA_API_KEY from secrets");
    }
  }

  validateFreeStandingJobSelector(
    errors,
    jobs,
    "concurrent-gateway-ports",
    "concurrent-gateway-ports",
  );

  validateChannelsAddRemoveJob(errors, jobs);
  validateOpenClawDiscordPairingJob(errors, jobs);
  validateOpenClawSlackPairingJob(errors, jobs);
  validateChannelsStopStartJob(errors, jobs);
  validateTelegramInjectionJob(errors, jobs);

  const reportToPr = asRecord(jobs["report-to-pr"]);
  if (Object.keys(reportToPr).length === 0) {
    errors.push("workflow missing report-to-pr job");
  } else {
    const needs = Array.isArray(reportToPr.needs) ? reportToPr.needs : [];
    for (const required of ["generate-matrix", "live"]) {
      if (!needs.includes(required)) errors.push(`report-to-pr job must wait for ${required}`);
    }
    validateFreeStandingInventoryCoverage(errors, jobs, needs, freeStandingInventory);
    const reportSteps = asSteps(reportToPr.steps);
    const report = requireJobStep(
      errors,
      "report-to-pr",
      reportSteps,
      "Post E2E target results to PR",
    );
    const reportEnv = asRecord(report?.env);
    if (reportEnv.JOBS !== "${{ inputs.jobs }}") {
      errors.push("report-to-pr step must pass jobs through JOBS env");
    }
    if (reportEnv.JOB_PR_NUMBER !== "${{ inputs.pr_number }}") {
      errors.push("report-to-pr step must pass pr_number through JOB_PR_NUMBER env");
    }
    if (reportEnv.JOB_TARGETS !== "${{ inputs.targets }}") {
      errors.push("report-to-pr step must pass targets through JOB_TARGETS env");
    }
    if (
      reportEnv.EXPLICIT_ONLY_JOBS !== "${{ needs.generate-matrix.outputs.explicit_only_jobs }}"
    ) {
      errors.push("report-to-pr must derive explicit-only jobs from workflow inventory");
    }
    const reportScript = stringValue(asRecord(report?.with).script ?? report?.run);
    if (!reportScript.includes("process.env.JOBS")) {
      errors.push("step 'Post E2E target results to PR' run script must include process.env.JOBS");
    }
    if (!reportScript.includes("process.env.JOB_TARGETS")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must include process.env.JOB_TARGETS",
      );
    }
    if (reportScript.includes("Number.parseInt(prNumberInput")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must not parse JOB_PR_NUMBER with Number.parseInt",
      );
    }
    if (!reportScript.includes("/^[1-9][0-9]*$/.test(prNumberInput)")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must validate JOB_PR_NUMBER with an all-digits regex before parsing",
      );
    }
    if (!reportScript.includes("Number.isSafeInteger(prNumber)")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must reject unsafe JOB_PR_NUMBER values before commenting",
      );
    }
    if (
      !reportScript.includes("github.rest.pulls.get") ||
      !reportScript.includes("pull_number: prNumber")
    ) {
      errors.push(
        "step 'Post E2E target results to PR' run script must verify JOB_PR_NUMBER identifies a pull request before commenting",
      );
    }
    if (
      !reportScript.includes("github.rest.pulls.list") ||
      !reportScript.includes("head: `${context.repo.owner}:${workflowBranch}`")
    ) {
      errors.push(
        "step 'Post E2E target results to PR' run script must fall back to branch PR lookup when JOB_PR_NUMBER is empty",
      );
    }
    if (!reportScript.includes("selectorValidationPassed")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must check selector validation before echoing selectors",
      );
    }
    if (!reportScript.includes("jobsRejected")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must omit rejected job selectors",
      );
    }
    if (!reportScript.includes("targetsRejected")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must omit rejected target selectors",
      );
    }
    if (!reportScript.includes("reportedEntries")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must filter reported entries for selective dispatches",
      );
    }
    if (!reportScript.includes("missingRequested")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must report missing requested jobs",
      );
    }
    if (!reportScript.includes("cancelled")) {
      errors.push("step 'Post E2E target results to PR' run script must count cancelled jobs");
    }
    if (!reportScript.includes("**Requested jobs:**")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must include **Requested jobs:**",
      );
    }
    if (!reportScript.includes("**Requested targets:**")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must include **Requested targets:**",
      );
    }
    if (!reportScript.includes("All default jobs passed")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must label empty dispatch as default jobs passed",
      );
    }
    if (!reportScript.includes("default-enabled free-standing jobs")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must say empty dispatch uses default-enabled free-standing jobs",
      );
    }
    if (!reportScript.includes("Explicit-only jobs skipped")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must list explicit-only skipped jobs on default dispatch",
      );
    }
    if (!reportScript.includes("jobs=${job}") || !reportScript.includes("jetson-nvmap-gpu")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must document the explicit Jetson jobs selector",
      );
    }
    if (!reportScript.includes("targets=${target}") || !reportScript.includes("jetson-nvmap-gpu")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must document the explicit Jetson target selector",
      );
    }
    if (!reportScript.includes("sandbox-rlimits-connect")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must document the explicit rlimit jobs selector",
      );
    }
    if (!reportScript.includes("sandbox-rlimits-connect")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must document the explicit rlimit target selector",
      );
    }
    for (const forbidden of ["toJSON(inputs.pr_number)", "toJSON(inputs.targets)"]) {
      if (reportScript.includes(forbidden)) {
        errors.push(
          `step 'Post E2E target results to PR' run script must not include ${forbidden}`,
        );
      }
    }
  }

  return errors;
}
