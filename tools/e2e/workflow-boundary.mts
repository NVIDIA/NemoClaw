// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import {
  CREDENTIAL_FREE_TEST_TAG,
  discoverCredentialFreeTests,
  SHARED_E2E_JOB_ID,
} from "./credential-free-tests.mts";
import {
  type HermesDashboardWorkflow,
  validateHermesDashboardWorkflow,
} from "./hermes-dashboard-workflow-boundary.mts";
import { validateHermesGpuStartupWorkflow } from "./hermes-gpu-startup-workflow-boundary.mts";
import {
  type InferenceSwitchWorkflow,
  validateInferenceSwitchWorkflow,
} from "./inference-switch-workflow-boundary.mts";
import {
  type OpenClawPluginRuntimeExdevWorkflow,
  validateOpenClawPluginRuntimeExdevWorkflow,
} from "./openclaw-plugin-runtime-exdev-workflow-boundary.mts";
import {
  type OpenShellGatewayAuthContractWorkflow,
  validateOpenShellGatewayAuthContractWorkflow,
} from "./openshell-gateway-auth-contract-workflow-boundary.mts";
import { validateOpenShellGatewayUpgradeWorkflow } from "./openshell-gateway-upgrade-workflow-boundary.mts";
import {
  type OperationsWorkflow,
  validateE2eOperationsWorkflow,
} from "./operations-workflow-boundary.mts";
import { validatePrepareE2eWorkflowBoundary } from "./prepare-e2e-workflow-boundary.mts";
import { validateSandboxOperationsWorkflow } from "./sandbox-operations-workflow-boundary.mts";
import { validateSecurityPostureWorkflow } from "./security-posture-workflow-boundary.mts";
import { validateUploadE2eArtifactsWorkflowBoundary } from "./upload-e2e-artifacts-workflow-boundary.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_E2E_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const DEFAULT_DOCKER_HUB_AUTH_ACTION_PATH = join(
  REPO_ROOT,
  ".github",
  "actions",
  "docker-auth-setup",
  "action.yaml",
);
const DEFAULT_DOCKER_HUB_AUTH_SCRIPT_PATH = join(
  REPO_ROOT,
  ".github",
  "scripts",
  "docker-auth-setup.sh",
);
const DEFAULT_HOST_DEPENDENCY_ACTION_PATH = join(
  REPO_ROOT,
  ".github",
  "actions",
  "host-dependency-setup",
  "action.yaml",
);
const DEFAULT_HOST_DEPENDENCY_SCRIPT_PATH = join(
  REPO_ROOT,
  ".github",
  "scripts",
  "host-dependency-setup.sh",
);

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  name?: string;
  run?: string;
  uses?: string;
  with?: WorkflowRecord;
};

export interface FreeStandingJobsInventory {
  allowedJobs: string[];
  workflowJobs: string[];
  explicitOnlyJobs: string[];
  freeStandingTargets: string[];
  targetToJob: Map<string, string>;
  liveTestToJobs: Map<string, string[]>;
}

export interface FocusedE2eJob {
  id: string;
  matchedFiles: string[];
}

type CachedFreeStandingJobsInventory = {
  mtimeMs: number;
  size: number;
  inventory: FreeStandingJobsInventory;
};

const SELECTOR_PATTERN = /^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$/;
const SELECTOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const LIVE_TEST_FILE_PATTERN = /test\/e2e\/live\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.test\.ts/g;
const FREE_STANDING_JOB_MARKER = "E2E_JOB";
const FREE_STANDING_TARGET_MARKER = "E2E_TARGET_ID";
const FREE_STANDING_DEFAULT_ENABLED_MARKER = "E2E_DEFAULT_ENABLED";
const EXPLICIT_ONLY_JOBS_WITHOUT_ENV_MARKER = new Set(["hermes-gpu-startup"]);
const COMMON_SECRET_ENV_NAMES = [
  "NVIDIA_API_KEY",
  "NVIDIA_INFERENCE_API_KEY",
  "DOCKERHUB_USERNAME",
  "DOCKERHUB_TOKEN",
  "GITHUB_TOKEN",
];
const FREE_STANDING_SELECTOR_SPECIAL_CASES = new Set(["hermes-e2e", "hermes-gpu-startup"]);
const ADAPTER_MANAGED_INFERENCE_JOBS = new Set(["hermes-e2e"]);
const PUBLIC_NVIDIA_ENDPOINT_KEY_JOBS = new Set([
  "device-auth-health",
  "model-router-provider-routed-inference",
]);
const NO_IMAGE_E2E_JOBS = new Set(["gateway-health-honest", SHARED_E2E_JOB_ID]);
const DOCKER_HUB_AUTH_STEP = "Authenticate to Docker Hub";
const DOCKER_HUB_CLEANUP_STEP = "Clean up Docker auth";
const DOCKER_HUB_CLEANUP_RUN = "bash .github/scripts/docker-auth-cleanup.sh";
const DOCKER_HUB_AUTH_PROVENANCE = {
  reference:
    "NVIDIA/NemoClaw/.github/actions/docker-auth-setup@78091da47e290f49b8fe3f3e70b72362a0853928",
  actionSha256: "cf93dcbd19589a56d1d58225fd6b3f8ad2180705662ff79a3407f340b5dba4c0",
  scriptSha256: "853a3f742f057c29ed465b63bed1ec8d8f306a1c046877a8556cadf290ef0cb6",
} as const;
const DOCKER_HUB_AUTH_USES = DOCKER_HUB_AUTH_PROVENANCE.reference;
const HOST_DEPENDENCY_ACTION_PROVENANCE = {
  reference:
    "NVIDIA/NemoClaw/.github/actions/host-dependency-setup@4def1501b34ce586f83b91af50a66b5d22b31d75",
  actionSha256: "1ac05a0e0a0159fa0850eb82fccb0704d0e49b15bc6f2d6e3b6bb04c7ab94923",
  scriptSha256: "2e910ed80b5dcf9aaf94230371fe586376c46f6df8fcbd76229063cbda1852c8",
} as const;
const HOST_DEPENDENCY_ACTION_USES = HOST_DEPENDENCY_ACTION_PROVENANCE.reference;
const DOCKER_HUB_CLEANUP_KEYS = ["if", "name", "run", "shell"];
// The general E2E workflow runs on schedule/manual dispatch. Its event set is
// intentionally distinct from the reusable image workflow's push/manual boundary.
const TRUSTED_DOCKER_HUB_PREDICATE =
  "github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && inputs.checkout_sha == ''";
const GUARDED_DOCKER_HUB_AUTH_REQUIRED = `\${{ ${TRUSTED_DOCKER_HUB_PREDICATE} && '1' || '0' }}`;
const GUARDED_DOCKER_HUB_USERNAME = `\${{ ${TRUSTED_DOCKER_HUB_PREDICATE} && secrets.DOCKERHUB_USERNAME || '' }}`;
const GUARDED_DOCKER_HUB_TOKEN = `\${{ ${TRUSTED_DOCKER_HUB_PREDICATE} && secrets.DOCKERHUB_TOKEN || '' }}`;
const GUARDED_HERMES_E2E_INFERENCE_KEY = `\${{ github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && inputs.checkout_sha == '' && (inputs.inference_mode || 'mock') != 'mock' && secrets.NVIDIA_INFERENCE_API_KEY || '' }}`;

function asRecord(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

export function validateDockerHubAuthAction(
  actionPath = DEFAULT_DOCKER_HUB_AUTH_ACTION_PATH,
  scriptPath = DEFAULT_DOCKER_HUB_AUTH_SCRIPT_PATH,
): string[] {
  const actionSource = readFileSync(actionPath, "utf8");
  const scriptSource = readFileSync(scriptPath, "utf8");
  const errors: string[] = [];

  if (
    createHash("sha256").update(actionSource).digest("hex") !==
    DOCKER_HUB_AUTH_PROVENANCE.actionSha256
  ) {
    errors.push(
      "docker-auth-setup action content must match the action reviewed at its immutable commit pin",
    );
  }
  if (
    createHash("sha256").update(scriptSource).digest("hex") !==
    DOCKER_HUB_AUTH_PROVENANCE.scriptSha256
  ) {
    errors.push(
      "docker-auth-setup script content must match the helper reviewed at its immutable commit pin",
    );
  }

  const expectedAction = {
    name: "docker-auth-setup",
    description: "Authenticate to Docker Hub from an isolated per-job Docker config, fail closed.",
    inputs: {
      "auth-required": {
        description: "Whether trusted Docker Hub credentials are present for this run.",
        required: true,
      },
      username: {
        description: "Docker Hub username; only populated for trusted runs.",
        required: false,
        default: "",
      },
      token: {
        description: "Docker Hub token; only populated for trusted runs.",
        required: false,
        default: "",
      },
    },
    runs: {
      using: "composite",
      steps: [
        {
          name: "Authenticate to Docker Hub",
          shell: "bash",
          env: {
            DOCKERHUB_AUTH_REQUIRED: "${{ inputs.auth-required }}",
            DOCKERHUB_USERNAME: "${{ inputs.username }}",
            DOCKERHUB_TOKEN: "${{ inputs.token }}",
          },
          run: 'bash "${{ github.action_path }}/../../scripts/docker-auth-setup.sh"',
        },
      ],
    },
  };
  if (!isDeepStrictEqual(asRecord(YAML.parse(actionSource)), expectedAction)) {
    errors.push(
      "docker-auth-setup action must preserve its exact three-input environment mapping and pinned helper invocation",
    );
  }

  return errors;
}

export function validateHostDependencyAction(
  actionPath = DEFAULT_HOST_DEPENDENCY_ACTION_PATH,
  scriptPath = DEFAULT_HOST_DEPENDENCY_SCRIPT_PATH,
): string[] {
  const actionSource = readFileSync(actionPath, "utf8");
  const scriptSource = readFileSync(scriptPath, "utf8");
  const errors: string[] = [];

  if (
    createHash("sha256").update(actionSource).digest("hex") !==
    HOST_DEPENDENCY_ACTION_PROVENANCE.actionSha256
  ) {
    errors.push(
      "host-dependency-setup action content must match the action reviewed at its immutable commit pin",
    );
  }
  if (
    createHash("sha256").update(scriptSource).digest("hex") !==
    HOST_DEPENDENCY_ACTION_PROVENANCE.scriptSha256
  ) {
    errors.push(
      "host-dependency-setup script content must match the helper reviewed at its immutable commit pin",
    );
  }

  const expectedAction = {
    name: "host-dependency-setup",
    description:
      "Install reviewed apt host dependencies with bounded retries from a trusted pinned action.",
    inputs: {
      packages: {
        description: "Space-separated apt packages from the reviewed allowlist (expect, iptables).",
        required: true,
      },
    },
    runs: {
      using: "composite",
      steps: [
        {
          name: "Install host dependencies",
          shell: "bash",
          env: {
            HOST_DEPENDENCY_PACKAGES: "${{ inputs.packages }}",
          },
          run: 'bash "${{ github.action_path }}/../../scripts/host-dependency-setup.sh"',
        },
      ],
    },
  };
  if (!isDeepStrictEqual(asRecord(YAML.parse(actionSource)), expectedAction)) {
    errors.push(
      "host-dependency-setup action must preserve its exact single-input package mapping and pinned helper invocation",
    );
  }

  return errors;
}

function collectLiveTestFiles(value: unknown): string[] {
  if (typeof value === "string") return value.match(LIVE_TEST_FILE_PATTERN) ?? [];
  if (Array.isArray(value)) return value.flatMap(collectLiveTestFiles);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectLiveTestFiles);
}

function addMapValue(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key) ?? [];
  if (!values.includes(value)) values.push(value);
  map.set(key, values);
}

function cloneStringArrayMap(map: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  return new Map([...map].map(([key, values]) => [key, [...values]]));
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
  const workflowJobs: string[] = [];
  const explicitOnlyJobs: string[] = [];
  const freeStandingTargets: string[] = [];
  const targetToJob = new Map<string, string>();
  const liveTestToJobs = new Map<string, string[]>();

  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob);
    const env = asRecord(job.env);
    if (jobId === SHARED_E2E_JOB_ID) continue;
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
    workflowJobs.push(jobId);
    for (const file of collectLiveTestFiles(rawJob)) addMapValue(liveTestToJobs, file, jobId);
    if (Object.hasOwn(env, FREE_STANDING_DEFAULT_ENABLED_MARKER)) {
      if (env[FREE_STANDING_DEFAULT_ENABLED_MARKER] !== "0") {
        errors.push(`${jobId} job ${FREE_STANDING_DEFAULT_ENABLED_MARKER} must be "0" when set`);
      } else {
        explicitOnlyJobs.push(jobId);
      }
    } else if (EXPLICIT_ONLY_JOBS_WITHOUT_ENV_MARKER.has(jobId)) {
      explicitOnlyJobs.push(jobId);
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

  if (Object.hasOwn(jobs, SHARED_E2E_JOB_ID)) {
    workflowJobs.push(SHARED_E2E_JOB_ID);
    try {
      for (const row of discoverCredentialFreeTests()) {
        allowedJobs.push(row.id);
        freeStandingTargets.push(row.id);
        targetToJob.set(row.id, SHARED_E2E_JOB_ID);
        addMapValue(liveTestToJobs, row.file, row.id);
      }
    } catch (error) {
      errors.push(
        `credential-free test discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (allowedJobs.length === 0) {
    errors.push("free-standing workflow metadata must declare at least one job");
  }
  for (const duplicate of findDuplicates(allowedJobs)) {
    errors.push(`free-standing workflow metadata repeats job id: ${duplicate}`);
  }
  for (const duplicate of findDuplicates(workflowJobs)) {
    errors.push(`free-standing workflow metadata repeats workflow job id: ${duplicate}`);
  }
  for (const duplicate of findDuplicates(freeStandingTargets)) {
    errors.push(`free-standing workflow metadata repeats target id: ${duplicate}`);
  }

  return {
    errors,
    inventory: {
      allowedJobs,
      workflowJobs,
      explicitOnlyJobs,
      freeStandingTargets,
      targetToJob,
      liveTestToJobs: new Map(
        [...liveTestToJobs]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([file, jobs]) => [
            file,
            [...jobs].sort((left, right) => left.localeCompare(right)),
          ]),
      ),
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
    workflowJobs: [...inventory.workflowJobs],
    explicitOnlyJobs: [...inventory.explicitOnlyJobs],
    freeStandingTargets: [...inventory.freeStandingTargets],
    targetToJob: new Map(inventory.targetToJob),
    liveTestToJobs: cloneStringArrayMap(inventory.liveTestToJobs),
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

export function focusedE2eJobsForChangedFiles(
  changedFiles: readonly string[],
  inventory: FreeStandingJobsInventory = readFreeStandingJobsInventory(),
): FocusedE2eJob[] {
  const matchedFilesByJob = new Map<string, string[]>();
  for (const file of [...new Set(changedFiles)].sort((left, right) => left.localeCompare(right))) {
    for (const job of inventory.liveTestToJobs.get(file) ?? []) {
      addMapValue(matchedFilesByJob, job, file);
    }
  }
  return [...matchedFilesByJob]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, matchedFiles]) => ({ id, matchedFiles }));
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

function extractCallArguments(script: string, callStart: number): string {
  const openIndex = script.indexOf("(", callStart);
  if (openIndex < 0) return "";
  let depth = 0;
  for (let index = openIndex; index < script.length; index += 1) {
    if (script[index] === "(") depth += 1;
    else if (script[index] === ")") {
      depth -= 1;
      if (depth === 0) return script.slice(openIndex + 1, index);
    }
  }
  return script.slice(openIndex + 1);
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

  const selectedFreeStandingJobs = new Set(splitSelector(jobs));
  const registryTargets: string[] = [];
  for (const target of splitSelector(targets)) {
    const job = freeStandingTargetToJob.get(target);
    if (job) selectedFreeStandingJobs.add(target);
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

function requireDockerEngineRebuilds(
  errors: string[],
  jobName: string,
  jobEnv: WorkflowRecord,
  steps: readonly WorkflowStep[],
): void {
  const hasSeparateCacheBuilder = steps.some((step) => {
    const uses = stringValue(step.uses);
    return (
      uses.startsWith("docker/setup-buildx-action@") || uses.startsWith("docker/build-push-action@")
    );
  });
  const routesBuildsAwayFromDocker = steps.some((step) => {
    const run = stringValue(step.run);
    return (
      Object.hasOwn(asRecord(step.env), "BUILDX_BUILDER") ||
      /BUILDX_BUILDER(?:=|<<)/u.test(run) ||
      /docker\s+buildx\s+use(?:\s|$)/u.test(run)
    );
  });
  if (
    Object.hasOwn(jobEnv, "BUILDX_BUILDER") ||
    hasSeparateCacheBuilder ||
    routesBuildsAwayFromDocker
  ) {
    errors.push(`${jobName} must keep rebuild builds on the Docker engine cache`);
  }
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

function requireRunFragmentBefore(
  errors: string[],
  step: WorkflowStep | undefined,
  before: string,
  after: string,
): void {
  if (!step) return;
  const run = stringValue(step.run);
  const beforeIndex = run.indexOf(before);
  const afterIndex = run.indexOf(after);
  if (beforeIndex === -1 || afterIndex === -1) return;
  if (beforeIndex > afterIndex) {
    errors.push(
      `step '${step.name ?? "<unnamed>"}' run script must include ${before} before ${after}`,
    );
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

function requireUploadPathDoesNotContain(
  errors: string[],
  uploadPath: string,
  forbidden: string,
): void {
  if (uploadPath.includes(forbidden)) {
    errors.push(`artifact upload path must not include ${forbidden}`);
  }
}

function validateHostDependencyActionStep(
  errors: string[],
  jobName: string,
  steps: readonly WorkflowStep[],
  stepName: string,
  expectedPackages: readonly string[],
): void {
  const step = requireJobStep(errors, jobName, steps, stepName);
  if (!step) return;
  if (step.uses !== HOST_DEPENDENCY_ACTION_USES) {
    errors.push(`${jobName} host dependency setup must invoke only ${HOST_DEPENDENCY_ACTION_USES}`);
  }
  if (step.run !== undefined || step.shell !== undefined || step.env !== undefined) {
    errors.push(
      `${jobName} host dependency setup must invoke the pinned action, not an inline script`,
    );
  }
  if (step["continue-on-error"] !== undefined) {
    errors.push(`${jobName} host dependency setup must fail closed`);
  }

  const withInputs = asRecord(step.with);
  const expectedPackagesValue = expectedPackages.join(" ");
  if (withInputs.packages !== expectedPackagesValue) {
    errors.push(`${jobName} host dependency install must map only '${expectedPackagesValue}'`);
  }
  const unexpectedWith = Object.keys(withInputs).filter((name) => name !== "packages");
  if (unexpectedWith.length > 0) {
    errors.push(`${jobName} host dependency setup must expose only the packages input`);
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

function validateInferenceRoutingJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "inference-routing";
  const steps = asSteps(asRecord(jobs[jobName]).steps);
  const run = requireJobStep(errors, jobName, steps, "Run inference routing live test");
  requireRunContains(errors, run, "test/e2e/live/inference-routing.test.ts");
  requireRunDoesNotContain(errors, run, "inference-routing-provider-smoke.test.ts");
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
  if (PUBLIC_NVIDIA_ENDPOINT_KEY_JOBS.has(jobName) || ADAPTER_MANAGED_INFERENCE_JOBS.has(jobName)) {
    return;
  }
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

  for (const jobName of inventory.workflowJobs) {
    const job = asRecord(jobs[jobName]);
    if (Object.keys(job).length === 0) continue;

    if (jobName !== SHARED_E2E_JOB_ID && !FREE_STANDING_SELECTOR_SPECIAL_CASES.has(jobName)) {
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
  for (const jobId of inventory.workflowJobs) {
    if (!Object.hasOwn(jobs, jobId)) {
      errors.push(`free-standing inventory job missing workflow job: ${jobId}`);
    }
    if (!reportNeeds.includes(jobId)) {
      errors.push(`report-to-pr job must wait for ${jobId}`);
    }
  }
  for (const [target, jobId] of inventory.targetToJob) {
    if (!inventory.workflowJobs.includes(jobId)) {
      errors.push(`free-standing inventory maps ${target} to unknown workflow job ${jobId}`);
      continue;
    }
    if (jobId === SHARED_E2E_JOB_ID) continue;
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

function validateSharedE2eJob(errors: string[], jobs: WorkflowRecord): void {
  const job = asRecord(jobs[SHARED_E2E_JOB_ID]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing shared E2E job");
    return;
  }

  if (job.name !== "Shared E2E (${{ matrix.id }})") {
    errors.push("shared E2E job name must expose the test ID");
  }
  if (job.needs !== "generate-matrix") {
    errors.push("shared E2E job must depend on generate-matrix");
  }
  if (job.if !== "${{ needs.generate-matrix.outputs.test_matrix != '[]' }}") {
    errors.push("shared E2E job must run only for a non-empty test matrix");
  }
  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("shared E2E job must run on ubuntu-latest");
  }
  if (job["timeout-minutes"] !== 15) {
    errors.push("shared E2E job timeout must remain 15 minutes");
  }

  const strategy = asRecord(job.strategy);
  if (strategy["fail-fast"] !== false) {
    errors.push("shared E2E strategy.fail-fast must be false");
  }
  if (
    asRecord(strategy.matrix).include !==
    "${{ fromJSON(needs.generate-matrix.outputs.test_matrix) }}"
  ) {
    errors.push("shared E2E matrix must come from tagged credential-free tests");
  }

  const jobEnv = asRecord(job.env);
  const expectedEnv = {
    CHECK_DOC_LINKS_REMOTE: "0",
    E2E_ARTIFACT_DIR: "${{ github.workspace }}/e2e-artifacts/live/${{ matrix.id }}",
    E2E_TARGET_ID: "${{ matrix.id }}",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_CLI_BIN: "${{ github.workspace }}/bin/nemoclaw.js",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RUN_LIVE_E2E: "1",
  };
  for (const [name, expected] of Object.entries(expectedEnv)) {
    if (jobEnv[name] !== expected) {
      errors.push(`shared E2E job must set ${name} to ${expected}`);
    }
  }
  if (Object.hasOwn(jobEnv, FREE_STANDING_JOB_MARKER)) {
    errors.push("shared E2E job must not become a jobs selector");
  }
  if (Object.hasOwn(jobEnv, "E2E_EXECUTION_PROFILE")) {
    errors.push("shared E2E job must not declare E2E_EXECUTION_PROFILE");
  }
  for (const secret of COMMON_SECRET_ENV_NAMES) {
    requireEnvDoesNotExposeSecret(errors, "shared E2E job", jobEnv, secret);
  }

  const steps = asSteps(job.steps);
  requireNoDispatchInputInterpolation(errors, steps);
  for (const step of steps) {
    for (const secret of COMMON_SECRET_ENV_NAMES) {
      requireEnvDoesNotExposeSecret(
        errors,
        `shared E2E step '${step.name ?? step.uses ?? "<unnamed>"}'`,
        asRecord(step.env),
        secret,
      );
    }
  }

  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) errors.push("shared E2E job missing checkout step");
  requireFullShaAction(errors, checkout, "shared E2E checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("shared E2E checkout must disable persisted credentials");
  }

  const runVitest = requireJobStep(
    errors,
    SHARED_E2E_JOB_ID,
    steps,
    "Run tagged credential-free test",
  );
  const runEnv = asRecord(runVitest?.env);
  if (runEnv.TEST_FILE !== "${{ matrix.file }}") {
    errors.push("shared E2E test step must pass matrix.file through TEST_FILE");
  }
  if (runEnv.TEST_PROJECT !== "${{ matrix.project }}") {
    errors.push("shared E2E test step must pass matrix.project through TEST_PROJECT");
  }
  requireRunContains(
    errors,
    runVitest,
    'npx vitest run --project "${TEST_PROJECT}" "${TEST_FILE}"',
  );
  requireRunContains(errors, runVitest, `--tags-filter=${CREDENTIAL_FREE_TEST_TAG}`);
  requireRunContains(errors, runVitest, "--reporter=test/e2e/risk-signal-reporter.ts");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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

  validateHostDependencyActionStep(
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
  requireRunContains(errors, runVitest, "test/e2e/live/network-policy.test.ts");
}

function validateIssue4434HostDependencies(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "issue-4434-tui-unreachable-inference";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push(`workflow missing ${jobName} job`);
    return;
  }
  validateHostDependencyActionStep(
    errors,
    jobName,
    asSteps(job.steps),
    "Install issue #4434 host dependencies",
    ["expect", "iptables"],
  );
}

function validateOpenclawTuiChatCorrelationHostDependencies(
  errors: string[],
  jobs: WorkflowRecord,
): void {
  const jobName = "openclaw-tui-chat-correlation";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push(`workflow missing ${jobName} job`);
    return;
  }
  const steps = asSteps(job.steps);
  validateHostDependencyActionStep(
    errors,
    jobName,
    steps,
    "Install OpenClaw TUI host dependencies",
    ["expect"],
  );
  const install = requireJobStep(errors, jobName, steps, "Install OpenClaw TUI host dependencies");
  const prepare = requireJobStep(errors, jobName, steps, "Prepare E2E workspace");
  if (install && prepare && steps.indexOf(install) >= steps.indexOf(prepare)) {
    errors.push(`${jobName} host dependencies must be installed before workspace prep`);
  }
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireDockerEngineRebuilds(errors, jobName, jobEnv, steps);
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireDockerEngineRebuilds(errors, jobName, jobEnv, steps);
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
  requireRunContains(errors, runVitest, "test/e2e/live/messaging-compatible-endpoint.test.ts");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  if (authStep.run !== undefined || authStep.shell !== undefined || authStep.env !== undefined) {
    errors.push(
      "canonical Docker Hub auth step must invoke the pinned composite action, not an inline script",
    );
  }
  if (authStep["continue-on-error"] !== undefined) {
    errors.push(
      "canonical Docker Hub auth step must fail closed when trusted authentication fails",
    );
  }

  if (authStep.uses !== DOCKER_HUB_AUTH_USES) {
    errors.push(`canonical Docker Hub auth step must invoke only ${DOCKER_HUB_AUTH_USES}`);
  }

  const authWith = asRecord(authStep.with);
  if (authWith["auth-required"] !== GUARDED_DOCKER_HUB_AUTH_REQUIRED) {
    errors.push(
      "canonical Docker Hub auth must gate auth-required on the trusted repository, main ref, and scheduled/manual events",
    );
  }
  if (authWith.username !== GUARDED_DOCKER_HUB_USERNAME) {
    errors.push(
      "canonical Docker Hub auth must gate username on the trusted repository, main ref, and scheduled/manual events",
    );
  }
  if (authWith.token !== GUARDED_DOCKER_HUB_TOKEN) {
    errors.push(
      "canonical Docker Hub auth must gate token on the trusted repository, main ref, and scheduled/manual events",
    );
  }
  const unexpectedWith = Object.keys(authWith).filter(
    (name) => !["auth-required", "username", "token"].includes(name),
  );
  if (unexpectedWith.length > 0) {
    errors.push("canonical Docker Hub auth step must expose only its three guarded inputs");
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
    .filter(([jobName, rawJob]) => {
      const env = asRecord(asRecord(rawJob).env);
      return env.E2E_JOB === "1" || jobName === SHARED_E2E_JOB_ID;
    })
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
    const expectedAuthIndex =
      jobName === "jetson-nvmap-gpu"
        ? checkoutIndex + 2
        : jobName === "hermes-gpu-startup"
          ? checkoutIndex + 3
          : checkoutIndex + 1;
    if (checkoutIndex < 0 || authIndex !== expectedAuthIndex) {
      errors.push(
        jobName === "jetson-nvmap-gpu"
          ? `${jobName} Docker Hub auth must run immediately after the Jetson dispatch guard`
          : `${jobName} Docker Hub auth must run immediately after checkout`,
      );
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
  requireRunContains(errors, runVitest, "test/e2e/live/double-onboard.test.ts");
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
  if (jobEnv.NEMOCLAW_E2E_INFERENCE_MODE !== "${{ inputs.inference_mode || 'mock' }}") {
    errors.push("hermes-e2e job must consume the defaulted inference mode input");
  }
  if ("NEMOCLAW_E2E_USE_HOSTED_INFERENCE" in jobEnv) {
    errors.push("hermes-e2e job must leave hosted inference selection to the adapter");
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
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== GUARDED_HERMES_E2E_INFERENCE_KEY) {
    errors.push(
      "hermes-e2e run step must guard NVIDIA_INFERENCE_API_KEY behind a trusted main-branch dispatch without a PR checkout and the inference mode condition",
    );
  }
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
  requireRunContains(errors, runVitest, "test/e2e/live/hermes-e2e.test.ts");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  if ("NEMOCLAW_E2E_USE_HOSTED_INFERENCE" in jobEnv) {
    errors.push("snapshot-commands job must not enable hosted inference");
  }
  for (const secret of [
    "NVIDIA_API_KEY",
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
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NEMOCLAW_E2E_USE_HOSTED_INFERENCE");
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_API_KEY");
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
    errors.push("snapshot-commands job missing checkout step");
  }
  requireFullShaAction(errors, checkout, "snapshot-commands checkout");
  if (asRecord(checkout?.with)["persist-credentials"] !== false) {
    errors.push("snapshot-commands checkout step must set persist-credentials=false");
  }

  const runVitest = requireJobStep(errors, jobName, steps, "Run snapshot commands live test");
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
  requireRunContains(
    errors,
    runVitest,
    "test/e2e/live/model-router-provider-routed-inference.test.ts",
  );
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
  if (jobEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/tunnel-lifecycle") {
    errors.push(
      "tunnel-lifecycle job must write artifacts under e2e-artifacts/live/tunnel-lifecycle",
    );
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  for (const name of [
    "NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
    "NEMOCLAW_PROVIDER",
    "NEMOCLAW_ENDPOINT_URL",
    "NEMOCLAW_MODEL",
    "NEMOCLAW_COMPAT_MODEL",
    "NEMOCLAW_PREFERRED_API",
  ]) {
    if (jobEnv[name] !== undefined) {
      errors.push(
        `channels-add-remove job must leave ${name} unset for its local inference fixture`,
      );
    }
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
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "NVIDIA_INFERENCE_API_KEY");
    requireEnvDoesNotExposeSecret(errors, stepName, stepEnv, "COMPATIBLE_API_KEY");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
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
  if (jobEnv.NEMOCLAW_E2E_SHARD !== "${{ matrix.agent }}") {
    errors.push(
      "bedrock-runtime-compatible-anthropic job must pass matrix.agent through NEMOCLAW_E2E_SHARD",
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
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
  requireRunContains(
    errors,
    runVitest,
    "test/e2e/live/bedrock-runtime-compatible-anthropic.test.ts",
  );
  requireRunDoesNotContain(errors, runVitest, "${{ inputs.");
}

function validateAllowJetsonRunnerQueueInput(
  errors: string[],
  dispatchInputs: WorkflowRecord,
): void {
  const input = requireInput(errors, dispatchInputs, "allow_jetson_runner_queue");
  if (input.type !== "boolean") {
    errors.push("workflow_dispatch allow_jetson_runner_queue input must be boolean");
  }
  if (input.default !== false) {
    errors.push("workflow_dispatch allow_jetson_runner_queue input must default to false");
  }
  const description = stringValue(input.description);
  if (
    !description.includes("Repository administrators") ||
    !description.includes("Jetson runner") ||
    !description.includes("authoritative") ||
    !description.includes("NVIDIA/NemoClaw Settings -> Actions -> Runners") ||
    !description.includes("timeout-minutes")
  ) {
    errors.push(
      "workflow_dispatch allow_jetson_runner_queue input must identify repository administrators and NVIDIA/NemoClaw Settings -> Actions -> Runners as the authoritative runner inventory, and document queued timeout behavior",
    );
  }
}

function validateJetsonRunnerDispatchGuard(errors: string[], jobs: WorkflowRecord): void {
  validateFreeStandingJobSelector(errors, jobs, "jetson-nvmap-gpu", "jetson-nvmap-gpu", true);

  const job = asRecord(jobs["jetson-nvmap-gpu"]);
  const guardedRunsOn =
    "${{ inputs.allow_jetson_runner_queue && (vars.JETSON_E2E_RUNNER_LABEL || 'linux-arm64-gpu-jetson-orin-latest-1') || 'ubuntu-latest' }}";
  if (job["runs-on"] !== guardedRunsOn) {
    errors.push(
      "jetson-nvmap-gpu job must use ubuntu-latest unless allow_jetson_runner_queue is true",
    );
  }

  const steps = asSteps(job.steps);
  const guard = namedStep(steps, "Guard Jetson runner dispatch");
  const checkoutIndex = steps.findIndex((step) =>
    stringValue(step.uses).startsWith("actions/checkout@"),
  );
  const guardIndex = steps.findIndex((step) => step.name === "Guard Jetson runner dispatch");
  const dockerAuthIndex = steps.findIndex((step) => step.name === DOCKER_HUB_AUTH_STEP);
  if (!guard) {
    errors.push("jetson-nvmap-gpu job missing step: Guard Jetson runner dispatch");
    return;
  }
  if (checkoutIndex < 0 || guardIndex <= checkoutIndex) {
    errors.push("jetson-nvmap-gpu dispatch guard must run after checkout");
  }
  if (dockerAuthIndex >= 0 && guardIndex >= dockerAuthIndex) {
    errors.push("jetson-nvmap-gpu dispatch guard must run before Docker Hub auth");
  }
  if (guard.if !== "${{ !inputs.allow_jetson_runner_queue }}") {
    errors.push(
      "jetson-nvmap-gpu dispatch guard must run unless allow_jetson_runner_queue is true",
    );
  }
  if (
    asRecord(guard.env).JETSON_E2E_RUNNER_LABEL !==
    "${{ vars.JETSON_E2E_RUNNER_LABEL || 'linux-arm64-gpu-jetson-orin-latest-1' }}"
  ) {
    errors.push("jetson-nvmap-gpu dispatch guard must receive the configured Jetson runner label");
  }
  requireRunContains(errors, guard, "allow_jetson_runner_queue=true");
  requireRunContains(errors, guard, "timeout-minutes");
  requireRunContains(errors, guard, "repository administrator");
  requireRunContains(errors, guard, "authoritative");
  requireRunContains(errors, guard, "NVIDIA/NemoClaw Settings -> Actions -> Runners");
  requireRunContains(errors, guard, "${JETSON_E2E_RUNNER_LABEL}");
  requireRunDoesNotContain(errors, guard, "linux-arm64-gpu-jetson-orin-latest-1");
}

export function validateJetsonRunnerDispatchBoundary(workflow: unknown): string[] {
  const workflowRecord = asRecord(workflow);
  const triggers = asRecord(workflowRecord.on ?? workflowRecord[true as unknown as string]);
  const workflowDispatch = asRecord(triggers.workflow_dispatch);
  const errors: string[] = [];

  validateAllowJetsonRunnerQueueInput(errors, asRecord(workflowDispatch.inputs));
  validateJetsonRunnerDispatchGuard(errors, asRecord(workflowRecord.jobs));
  return errors;
}

function validateSandboxRlimitConnectJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "sandbox-rlimits-connect";
  const job = asRecord(jobs[jobName]);
  if (job.needs !== "generate-matrix") {
    errors.push(`${jobName} job must depend on generate-matrix`);
  }
  if (job.if !== explicitOnlyFreeStandingJobIf(jobName, jobName)) {
    errors.push(`${jobName} job must run only when explicitly selected`);
  }
  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push(`${jobName} job must run on ubuntu-latest`);
  }
  if (job["timeout-minutes"] !== 60) {
    errors.push(`${jobName} job must retain its 60 minute connect budget`);
  }

  const env = asRecord(job.env);
  if (env.E2E_DEFAULT_ENABLED !== "0") {
    errors.push(`${jobName} job must remain explicit-only`);
  }
  if (env.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push(`${jobName} job must set NEMOCLAW_RUN_LIVE_E2E=1`);
  }
  if (env.NEMOCLAW_E2E_CONNECT_RLIMITS !== "1") {
    errors.push(`${jobName} job must opt in with NEMOCLAW_E2E_CONNECT_RLIMITS=1`);
  }
  if (env.NEMOCLAW_CLI_BIN !== "${{ github.workspace }}/bin/nemoclaw.js") {
    errors.push(`${jobName} job must use the repo CLI launcher`);
  }
  if (
    env.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/sandbox-rlimits-connect"
  ) {
    errors.push(`${jobName} job must write artifacts under e2e-artifacts/live/${jobName}`);
  }

  const run = namedStep(asSteps(job.steps), "Run sandbox rlimit connect live test");
  if (!run) {
    errors.push(`${jobName} job missing step: Run sandbox rlimit connect live test`);
    return;
  }
  if (!stringValue(run.run).includes("test/e2e/live/sandbox-rlimits-connect.test.ts")) {
    errors.push(`${jobName} job must run sandbox-rlimits-connect.test.ts`);
  }
  if (asRecord(run.env).NVIDIA_API_KEY !== "${{ secrets.NVIDIA_API_KEY }}") {
    errors.push(`${jobName} step must receive NVIDIA_API_KEY from secrets`);
  }
}

function validateInferenceModeInput(
  errors: string[],
  workflow: WorkflowRecord,
  dispatchInputs: WorkflowRecord,
): void {
  const input = requireInput(errors, dispatchInputs, "inference_mode");
  if (
    input.type !== "choice" ||
    input.default !== "mock" ||
    JSON.stringify(input.options) !== JSON.stringify(["mock", "internal-nvidia", "public-nvidia"])
  ) {
    errors.push("workflow_dispatch inference_mode must be the canonical three-mode choice");
  }
  if ("NEMOCLAW_E2E_INFERENCE_MODE" in asRecord(workflow.env)) {
    errors.push("workflow env must leave inference mode scoped to adapter-consuming jobs");
  }
}

function validateInferenceModeGeneration(
  errors: string[],
  step: WorkflowStep | undefined,
  env: WorkflowRecord,
): void {
  if (env.INFERENCE_MODE !== "${{ inputs.inference_mode || 'mock' }}") {
    errors.push("matrix generation step must pass the defaulted inference mode through env");
  }
  requireRunContains(errors, step, "--ci-output");
}

export function validateE2eWorkflow(workflowValue: unknown): string[] {
  const workflow = asRecord(workflowValue);
  const errors: string[] = [];
  errors.push(...validatePrepareE2eWorkflowBoundary(workflow));
  errors.push(...validateUploadE2eArtifactsWorkflowBoundary(workflow));
  errors.push(...validateHermesDashboardWorkflow(workflow as unknown as HermesDashboardWorkflow));
  errors.push(...validateHermesGpuStartupWorkflow(workflow));
  errors.push(...validateInferenceSwitchWorkflow(workflow as unknown as InferenceSwitchWorkflow));
  errors.push(
    ...validateOpenClawPluginRuntimeExdevWorkflow(
      workflow as unknown as OpenClawPluginRuntimeExdevWorkflow,
    ),
  );
  errors.push(
    ...validateOpenShellGatewayAuthContractWorkflow(
      workflow as unknown as OpenShellGatewayAuthContractWorkflow,
    ),
  );
  errors.push(...validateOpenShellGatewayUpgradeWorkflow(workflow));
  errors.push(...validateE2eOperationsWorkflow(workflow as unknown as OperationsWorkflow));
  errors.push(...validateSecurityPostureWorkflow(workflow));
  const triggers = asRecord(workflow.on ?? workflow[true as unknown as string]);

  const workflowDispatch = requireWorkflowDispatch(errors, triggers);
  requireScheduledRun(errors, triggers);
  rejectUnexpectedTriggers(errors, triggers);

  const dispatchInputs = asRecord(workflowDispatch.inputs);
  requireInput(errors, dispatchInputs, "targets");
  validateInferenceModeInput(errors, workflow, dispatchInputs);
  const jobsInput = requireInput(errors, dispatchInputs, "jobs");
  const jobsDescription = stringValue(jobsInput.description);
  if (!jobsDescription.includes("default-enabled tests")) {
    errors.push(
      "workflow_dispatch jobs input description must say empty dispatch runs default-enabled tests",
    );
  }
  if (!jobsDescription.includes("explicit-only tests")) {
    errors.push(
      "workflow_dispatch jobs input description must say explicit-only tests are skipped unless selected",
    );
  }
  if (Object.hasOwn(dispatchInputs, "test_filter")) {
    errors.push("workflow_dispatch must not expose legacy test_filter input");
  }

  const permissions = asRecord(workflow.permissions);
  if (permissions.contents !== "read") errors.push("workflow permissions.contents must be read");

  const jobs = asRecord(workflow.jobs);
  errors.push(...validateJetsonRunnerDispatchBoundary(workflow));
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
  if (
    generateOutputs.matrix !==
    "${{ steps.controller_matrix.outputs.matrix || steps.matrix.outputs.matrix }}"
  ) {
    errors.push("generate-matrix job must expose trusted controller matrix output");
  }
  if (generateOutputs.test_matrix !== "${{ steps.matrix.outputs.test_matrix }}") {
    errors.push("generate-matrix job must expose test_matrix output");
  }
  if (generateOutputs.hermes_selected !== "${{ steps.matrix.outputs.hermes_selected }}") {
    errors.push("generate-matrix job must expose hermes_selected output");
  }
  if (generateOutputs.explicit_only_jobs !== "${{ steps.matrix.outputs.explicit_only_jobs }}") {
    errors.push("generate-matrix job must expose explicit_only_jobs output");
  }
  const generateSteps = asSteps(generateMatrix.steps);
  requireNoDispatchInputInterpolation(errors, generateSteps);
  const controllerMatrix = requireJobStep(
    errors,
    "generate-matrix",
    generateSteps,
    "Build trusted controller target matrix",
  );
  if (controllerMatrix?.id !== "controller_matrix") {
    errors.push("trusted controller matrix step must use id controller_matrix");
  }
  if (controllerMatrix?.if !== "${{ inputs.checkout_sha != '' }}") {
    errors.push("trusted controller matrix step must run only for controller dispatches");
  }
  if (controllerMatrix?.shell !== "bash") {
    errors.push("trusted controller matrix step must use bash");
  }
  const controllerMatrixEnv = asRecord(controllerMatrix?.env);
  if (controllerMatrixEnv.TARGETS !== "${{ inputs.targets }}") {
    errors.push("trusted controller matrix step must bind targets through TARGETS env");
  }
  requireRunContains(errors, controllerMatrix, 'case "${TARGETS}" in');
  requireRunContains(errors, controllerMatrix, "matrix='[]'");
  requireRunContains(errors, controllerMatrix, "ubuntu-repo-cloud-langchain-deepagents-code");
  if (!stringValue(controllerMatrix?.run).includes('"runner":"ubuntu-latest"')) {
    errors.push("trusted controller matrix must pin typed target runner to ubuntu-latest");
  }
  requireRunContains(
    errors,
    controllerMatrix,
    "PR E2E target is not approved by the trusted controller",
  );
  requireRunContains(
    errors,
    controllerMatrix,
    `printf 'matrix=%s\\n' "\${matrix}" >> "\${GITHUB_OUTPUT}"`,
  );
  const generateCheckout = generateSteps.find((step) =>
    stringValue(step.uses).startsWith("actions/checkout@"),
  );
  if (!generateCheckout) errors.push("generate-matrix job missing checkout step");
  if (
    controllerMatrix &&
    generateCheckout &&
    generateSteps.indexOf(controllerMatrix) >= generateSteps.indexOf(generateCheckout)
  ) {
    errors.push("trusted controller matrix step must run before PR checkout");
  }
  requireFullShaAction(errors, generateCheckout, "generate-matrix checkout");
  if (asRecord(generateCheckout?.with)["persist-credentials"] !== false) {
    errors.push("generate-matrix checkout step must set persist-credentials=false");
  }
  const generate = requireStep(errors, generateSteps, "Generate E2E target matrix");
  const generateEnv = asRecord(generate?.env);
  if (generateEnv.CHECKOUT_SHA !== "${{ inputs.checkout_sha }}") {
    errors.push("matrix generation step must bind controller checkout through CHECKOUT_SHA env");
  }
  if (generateEnv.CONTROLLER_MATRIX !== "${{ steps.controller_matrix.outputs.matrix }}") {
    errors.push("matrix generation step must receive the trusted controller matrix");
  }
  if (generateEnv.JOBS !== "${{ inputs.jobs }}") {
    errors.push("matrix generation step must pass jobs through JOBS env");
  }
  if (generateEnv.TARGETS !== "${{ inputs.targets }}") {
    errors.push("matrix generation step must pass targets through TARGETS env");
  }
  validateInferenceModeGeneration(errors, generate, generateEnv);
  requireRunContains(errors, generate, "npx tsx tools/e2e/workflow-plan.mts");
  requireRunContains(errors, generate, "--ci-output");
  requireRunContains(errors, generate, 'if [ -n "${CHECKOUT_SHA}" ]');
  requireRunContains(errors, generate, "GITHUB_OUTPUT");
  requireRunContains(errors, generate, "expected_controller_matrix=");
  requireRunContains(errors, generate, "actual_controller_matrix=");
  requireRunContains(errors, generate, ': > "${GITHUB_OUTPUT}"');
  requireRunContains(
    errors,
    generate,
    "E2E planner matrix does not match controller-selected targets",
  );

  const liveTargets = asRecord(jobs["live"]);
  if (Object.keys(liveTargets).length === 0) errors.push("workflow missing live job");
  if (liveTargets["runs-on"] !== "${{ matrix.runner }}") {
    errors.push("live job must run on the matrix runner");
  }
  if (liveTargets.needs !== "generate-matrix") {
    errors.push("live job must depend on generate-matrix");
  }
  if (liveTargets.if !== "${{ needs.generate-matrix.outputs.matrix != '[]' }}") {
    errors.push("live job must run whenever the trusted planner emits typed targets");
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

  const dcodeTargetIf = "${{ matrix.id == 'ubuntu-repo-cloud-langchain-deepagents-code' }}";
  const configureTrace = requireStep(errors, steps, "Configure live E2E trace directory");
  const configureTraceEnv = asRecord(configureTrace?.env);
  if (configureTraceEnv.TARGET_ID !== "${{ matrix.id }}") {
    errors.push("live trace setup step must pass matrix.id through TARGET_ID env");
  }
  if (configureTrace?.["if"] !== undefined) {
    errors.push("live trace setup step must run before live E2E tests without an if condition");
  }
  if (stringValue(jobEnv.NEMOCLAW_TRACE_DIR).length > 0) {
    errors.push("live job must not set NEMOCLAW_TRACE_DIR at job scope");
  }
  requireRunContains(errors, configureTrace, "NEMOCLAW_TRACE_DIR=%s");
  requireRunContains(errors, configureTrace, "${RUNNER_TEMP}/nemoclaw-e2e-traces/${TARGET_ID}");
  requireRunContains(errors, configureTrace, '>> "${GITHUB_ENV}"');

  const dcodeHostDependencies = requireStep(
    errors,
    steps,
    "Install Deep Agents Code TUI host dependencies",
  );
  validateHostDependencyActionStep(
    errors,
    "live",
    steps,
    "Install Deep Agents Code TUI host dependencies",
    ["expect"],
  );
  if (dcodeHostDependencies?.if !== dcodeTargetIf) {
    errors.push("live DCode TUI host dependencies must be scoped to the typed DCode target");
  }

  const prepareWorkspace = requireStep(errors, steps, "Prepare E2E workspace");
  if (
    dcodeHostDependencies &&
    prepareWorkspace &&
    steps.indexOf(dcodeHostDependencies) >= steps.indexOf(prepareWorkspace)
  ) {
    errors.push("live DCode TUI host dependencies must be installed before workspace prep");
  }

  const dcodeProfileImportGate = requireStep(
    errors,
    steps,
    "Verify DCode profile import gate rejects missing base dependencies",
  );
  if (
    Object.hasOwn(asRecord(dcodeProfileImportGate?.env), "NEMOCLAW_DCODE_PROFILE_GATE_BASE_IMAGE")
  ) {
    errors.push(
      "live DCode profile import gate must build the reviewed repository base without an override",
    );
  }
  if (dcodeProfileImportGate?.["if"] !== dcodeTargetIf) {
    errors.push("live DCode profile import gate must be scoped to the typed DCode target");
  }
  if (dcodeProfileImportGate?.shell !== "bash") {
    errors.push("live DCode profile import gate must use bash");
  }
  if (
    stringValue(dcodeProfileImportGate?.run).trim() !==
    "bash scripts/check-dcode-profile-import-gate.sh"
  ) {
    errors.push("live DCode profile import gate must run the reviewed negative-build script");
  }
  const dcodeGateIndex = dcodeProfileImportGate
    ? steps.indexOf(dcodeProfileImportGate)
    : steps.length;
  const routesDcodeBuildsThroughBuildx = steps.slice(0, dcodeGateIndex).some((step) => {
    const stepCanRunForDcode = step["if"] === undefined || step["if"] === dcodeTargetIf;
    const run = stringValue(step.run);
    return (
      stepCanRunForDcode &&
      (stringValue(step.uses).startsWith("docker/setup-buildx-action@") ||
        /BUILDX_BUILDER(?:=|<<)/u.test(run) ||
        /docker\s+buildx\s+use(?:\s|$)/u.test(run))
    );
  });
  if (
    Object.hasOwn(jobEnv, "BUILDX_BUILDER") ||
    Object.hasOwn(asRecord(dcodeProfileImportGate?.env), "BUILDX_BUILDER") ||
    routesDcodeBuildsThroughBuildx
  ) {
    errors.push(
      "live DCode profile import gate must keep its local image chain on the Docker engine",
    );
  }

  const runVitest = requireStep(errors, steps, "Run live E2E tests");
  if (
    prepareWorkspace &&
    dcodeProfileImportGate &&
    steps.indexOf(prepareWorkspace) >= steps.indexOf(dcodeProfileImportGate)
  ) {
    errors.push("live DCode profile import gate must run after workspace prep");
  }
  if (
    dcodeProfileImportGate &&
    runVitest &&
    steps.indexOf(dcodeProfileImportGate) >= steps.indexOf(runVitest)
  ) {
    errors.push("live DCode profile import gate must run before live E2E tests");
  }
  const runVitestEnv = asRecord(runVitest?.env);
  if (runVitestEnv.E2E_TARGET_ID !== "${{ matrix.id }}") {
    errors.push("live E2E step must bind risk-signal identity to matrix.id");
  }
  if (runVitestEnv.TARGET_ID !== "${{ matrix.id }}") {
    errors.push("live E2E step must pass matrix.id through TARGET_ID env");
  }
  if (runVitestEnv.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push("live E2E step must receive NVIDIA_INFERENCE_API_KEY from secrets");
  }
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
  requireRunContains(errors, runVitest, "test/e2e/live/registry-targets.test.ts");
  requireRunContains(errors, runVitest, '"^${TARGET_ID}$"');

  const sanitizeTrace = requireStep(errors, steps, "Build trusted live E2E timing summary");
  const sanitizeTraceEnv = asRecord(sanitizeTrace?.env);
  if (sanitizeTrace?.["if"] !== "always()") {
    errors.push("live trace sanitizer must always run");
  }
  if (sanitizeTraceEnv.TARGET_ID !== "${{ matrix.id }}") {
    errors.push("live trace sanitizer must pass matrix.id through TARGET_ID env");
  }
  requireRunContains(errors, sanitizeTrace, "${RUNNER_TEMP}/nemoclaw-e2e-traces/${TARGET_ID}");
  requireRunContains(
    errors,
    sanitizeTrace,
    '[ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ]',
  );
  requireRunContains(errors, sanitizeTrace, "scripts/e2e/sanitize-trace-timing.py");
  requireRunFragmentBefore(
    errors,
    sanitizeTrace,
    'expected_trace_dir="${RUNNER_TEMP}/nemoclaw-e2e-traces/${TARGET_ID}"',
    "python3 scripts/e2e/sanitize-trace-timing.py",
  );
  requireRunFragmentBefore(
    errors,
    sanitizeTrace,
    '[ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ]',
    "python3 scripts/e2e/sanitize-trace-timing.py",
  );
  requireRunContains(errors, sanitizeTrace, '"${NEMOCLAW_TRACE_DIR}"');
  requireRunContains(errors, sanitizeTrace, '"${E2E_ARTIFACT_DIR}/${TARGET_ID}"');

  const deleteTrace = requireStep(errors, steps, "Delete raw live E2E traces");
  const deleteTraceEnv = asRecord(deleteTrace?.env);
  if (deleteTrace?.["if"] !== "always()") {
    errors.push("live raw trace cleanup must always run");
  }
  if (deleteTraceEnv.TARGET_ID !== "${{ matrix.id }}") {
    errors.push("live raw trace cleanup must pass matrix.id through TARGET_ID env");
  }
  requireRunContains(errors, deleteTrace, "${RUNNER_TEMP}/nemoclaw-e2e-traces/${TARGET_ID}");
  requireRunContains(errors, deleteTrace, '[ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ]');
  requireRunContains(errors, deleteTrace, 'rm -rf -- "${NEMOCLAW_TRACE_DIR}"');

  const configureTraceIndex = steps.indexOf(configureTrace as WorkflowStep);
  const runVitestIndex = steps.indexOf(runVitest as WorkflowStep);
  const sanitizeTraceIndex = steps.indexOf(sanitizeTrace as WorkflowStep);
  const deleteTraceIndex = steps.indexOf(deleteTrace as WorkflowStep);
  const prepareWorkspaceIndex = steps.indexOf(prepareWorkspace as WorkflowStep);
  if (
    configureTraceIndex === -1 ||
    prepareWorkspaceIndex === -1 ||
    runVitestIndex === -1 ||
    sanitizeTraceIndex === -1 ||
    deleteTraceIndex === -1 ||
    !(
      configureTraceIndex < prepareWorkspaceIndex &&
      prepareWorkspaceIndex < runVitestIndex &&
      runVitestIndex < sanitizeTraceIndex &&
      sanitizeTraceIndex < deleteTraceIndex
    )
  ) {
    errors.push(
      "live trace setup, workspace preparation, Vitest run, sanitizer, and cleanup steps must stay in order",
    );
  }

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

  const upload = requireStep(errors, steps, "Upload E2E artifacts");
  const uploadWith = asRecord(upload?.with);
  if (uploadWith.name !== "e2e-${{ matrix.id }}") {
    errors.push("artifact upload name must include matrix.id");
  }
  const uploadPath = stringValue(uploadWith.path);
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/live/${{ matrix.id }}/run-plan.json",
  );
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/live/${{ matrix.id }}/target.json");
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/live/${{ matrix.id }}/target-result.json",
  );
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/live/${{ matrix.id }}/environment.result.json",
  );
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/live/${{ matrix.id }}/onboarding.result.json",
  );
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/live/${{ matrix.id }}/state-validation.result.json",
  );
  requireUploadPathContains(
    errors,
    uploadPath,
    "e2e-artifacts/live/${{ matrix.id }}/cloud-onboard-trace-timing-summary.json",
  );
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/live/risk-signal.json");
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/live/${{ matrix.id }}/actions/");
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/live/${{ matrix.id }}/logs/");
  requireUploadPathContains(errors, uploadPath, "e2e-artifacts/live/${{ matrix.id }}/shell/");
  requireUploadPathDoesNotContain(errors, uploadPath, "nemoclaw-e2e-traces");
  requireUploadPathDoesNotContain(errors, uploadPath, "NEMOCLAW_TRACE_DIR");
  for (const line of uploadPath.split("\n")) {
    if (line.trim() === "e2e-artifacts/live/${{ matrix.id }}/") {
      errors.push("artifact upload path must not list the whole matrix artifact directory");
    }
  }

  const cloudOnboardSteps = asSteps(asRecord(jobs["cloud-onboard"]).steps);
  validateHostDependencyActionStep(
    errors,
    "cloud-onboard",
    cloudOnboardSteps,
    "Install cloud-onboard DCode TUI host dependencies",
    ["expect"],
  );
  const cloudOnboardHostDependencies = requireStep(
    errors,
    cloudOnboardSteps,
    "Install cloud-onboard DCode TUI host dependencies",
  );
  const cloudOnboardPrepareWorkspace = requireStep(
    errors,
    cloudOnboardSteps,
    "Prepare E2E workspace",
  );
  if (
    cloudOnboardHostDependencies &&
    cloudOnboardPrepareWorkspace &&
    cloudOnboardSteps.indexOf(cloudOnboardHostDependencies) >=
      cloudOnboardSteps.indexOf(cloudOnboardPrepareWorkspace)
  ) {
    errors.push("cloud-onboard DCode TUI host dependencies must precede workspace prep");
  }

  validateSharedE2eJob(errors, jobs);
  validateSkillAgentJob(errors, jobs);
  validateFreeStandingJobSelector(errors, jobs, "credential-migration", "credential-migration");
  validateFreeStandingJobSelector(errors, jobs, "sessions-agents-cli", "sessions-agents-cli");
  validateFreeStandingJobSelector(errors, jobs, "inference-routing", "inference-routing");
  validateInferenceRoutingJob(errors, jobs);
  validateCloudInferenceJob(errors, jobs);
  validateDoubleOnboardJob(errors, jobs);
  validateHermesE2EJob(errors, jobs);
  validateFreeStandingJobSelector(errors, jobs, "hermes-discord", "hermes-discord");
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
  validateFreeStandingJobSelector(errors, jobs, "gateway-guard-recovery", "gateway-guard-recovery");
  validateGatewayGuardRecoveryJob(errors, jobs);
  validateFreeStandingJobSelector(
    errors,
    jobs,
    "issue-4434-tui-unreachable-inference",
    "issue-4434-tui-unreachable-inference",
  );
  validateIssue4434HostDependencies(errors, jobs);
  validateOpenclawTuiChatCorrelationHostDependencies(errors, jobs);
  validateDiagnosticsJob(errors, jobs);
  validateModelRouterProviderRoutedInferenceJob(errors, jobs);
  validateSnapshotCommandsJob(errors, jobs);
  errors.push(...validateSandboxOperationsWorkflow({ jobs }));
  validateSparkInstallJob(errors, jobs);
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

  validateSandboxRlimitConnectJob(errors, jobs);

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
    if (reportEnv.TEST_MATRIX !== "${{ needs.generate-matrix.outputs.test_matrix }}") {
      errors.push("report-to-pr must receive the credential-free test matrix");
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
    if (
      !reportScript.includes("tools/e2e/report-e2e-results.mts") ||
      !reportScript.includes("process.env.GITHUB_WORKSPACE")
    ) {
      errors.push(
        "step 'Post E2E target results to PR' run script must load the trusted report helper from the checked-out workspace",
      );
    }
    const prNumberAssignment = /\b(?:const|let)\s+(\w+)\s*=\s*await\s+resolveReportPr\(/.exec(
      reportScript,
    );
    if (!prNumberAssignment) {
      errors.push(
        "step 'Post E2E target results to PR' run script must assign resolveReportPr's result before use",
      );
    } else if (!new RegExp(`issue_number:\\s*${prNumberAssignment[1]}\\b`).test(reportScript)) {
      errors.push(
        "step 'Post E2E target results to PR' run script must pass resolveReportPr's result as the comment issue_number",
      );
    }
    const loadJobsAssignment = /\{\s*([^}]+)\}\s*=\s*await\s+loadReportJobs\(/.exec(reportScript);
    if (!loadJobsAssignment) {
      errors.push(
        "step 'Post E2E target results to PR' run script must destructure loadReportJobs's result before use",
      );
    } else {
      const renderCallIndex = reportScript.indexOf("renderE2eReport(");
      const renderArguments =
        renderCallIndex >= 0 ? extractCallArguments(reportScript, renderCallIndex) : "";
      const loadedNames = loadJobsAssignment[1]
        .split(",")
        .map((name) => name.split(":").pop()?.trim())
        .filter((name): name is string => Boolean(name));
      if (!loadedNames.some((name) => new RegExp(`\\b${name}\\b`).test(renderArguments))) {
        errors.push(
          "step 'Post E2E target results to PR' run script must pass loadReportJobs's result into renderE2eReport",
        );
      }
    }
    const reportAssignment = /\b(?:const|let)\s+(\w+)\s*=\s*renderE2eReport\(/.exec(reportScript);
    if (!reportAssignment) {
      errors.push(
        "step 'Post E2E target results to PR' run script must assign renderE2eReport's result before use",
      );
    } else if (!new RegExp(`body:\\s*${reportAssignment[1]}\\.body\\b`).test(reportScript)) {
      errors.push(
        "step 'Post E2E target results to PR' run script must pass renderE2eReport's result body as the comment body",
      );
    }
    if (reportScript.includes("checkout_sha")) {
      errors.push(
        "step 'Post E2E target results to PR' run script must not reference checkout_sha",
      );
    }
    const reportCheckout = reportSteps.find((step) =>
      stringValue(asRecord(step).uses).startsWith("actions/checkout@"),
    );
    if (!reportCheckout) {
      errors.push("report-to-pr must check out the trusted workflow revision before reporting");
    } else {
      const checkoutWith = asRecord(asRecord(reportCheckout).with);
      if (checkoutWith.ref !== "${{ github.workflow_sha }}") {
        errors.push("report-to-pr must pin the report helper checkout to github.workflow_sha");
      }
      if (checkoutWith["persist-credentials"] !== false) {
        errors.push("report-to-pr report helper checkout must not persist credentials");
      }
      if (
        !stringValue(checkoutWith["sparse-checkout"]).includes("tools/e2e/report-e2e-results.mts")
      ) {
        errors.push("report-to-pr report helper checkout must sparse-checkout the report helper");
      }
      const reportStepIndex = reportSteps.findIndex(
        (step) => asRecord(step).name === "Post E2E target results to PR",
      );
      if (reportStepIndex >= 0 && reportSteps.indexOf(reportCheckout) >= reportStepIndex) {
        errors.push("report-to-pr must check out the report helper before the reporting step");
      }
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

export function validateE2eWorkflowBoundary(workflowPath = DEFAULT_E2E_WORKFLOW_PATH): string[] {
  return [
    ...validateDockerHubAuthAction(),
    ...validateHostDependencyAction(),
    ...validateE2eWorkflow(readWorkflowRecord(workflowPath)),
  ];
}
