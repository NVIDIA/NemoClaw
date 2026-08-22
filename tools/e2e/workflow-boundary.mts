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
  HERMES_TIMEOUT_CONTRACTS,
  HERMES_TIMEOUT_HEADROOM_MAX_MINUTES,
  HERMES_TIMEOUT_HEADROOM_MINUTES,
} from "./hermes-timeout-contract.mts";
import { validateLlamaCppDgxSparkQualificationWorkflow } from "./llama-cpp-dgx-spark-qualification-workflow-boundary.mts";
import { validateManagedImageMultiarchWorkflow } from "./managed-image-multiarch-workflow-boundary.mts";
import { validateManagedImageProtectedRuntimeWorkflow } from "./managed-image-protected-runtime-workflow-boundary.mts";
import {
  type OpenClawPluginRuntimeExdevWorkflow,
  validateOpenClawPluginRuntimeExdevWorkflow,
} from "./openclaw-plugin-runtime-exdev-workflow-boundary.mts";
import {
  type OpenShellGatewayAuthContractWorkflow,
  validateOpenShellGatewayAuthContractWorkflow,
} from "./openshell-gateway-auth-contract-workflow-boundary.mts";
import {
  type OperationsWorkflow,
  validateE2eOperationsWorkflow,
} from "./operations-workflow-boundary.mts";
import { validateRunnerComparisonWorkflowBoundary } from "./runner-comparison-workflow-boundary.mts";
import { normalizeE2eSelectorIds } from "./selector-aliases.mts";
import {
  type E2eExecutionRow,
  validateE2eExecutionRows,
  validateE2eExecutionMetadata,
} from "./execution-coverage.mts";
import { validateStandardProfileWorkflowBoundary } from "./standard-profile-workflow-boundary.mts";
import {
  validateTrustedHermesSwapHelperSource,
  validateTrustedHermesSwapWorkflow,
} from "./trusted-hermes-swap-workflow-boundary.mts";
import {
  E2E_ACTION_PROVENANCE,
  UPLOAD_E2E_ARTIFACTS_ACTION,
  validateUploadE2eArtifactsWorkflowBoundary,
} from "./upload-e2e-artifacts-workflow-boundary.mts";
import { validateE2eWorkspaceBootstrapBoundary } from "./workspace-bootstrap-workflow-boundary.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_E2E_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const DEFAULT_LIVE_VITEST_INVOCATION_PATH = join(
  REPO_ROOT,
  "tools",
  "e2e",
  "live-vitest-invocation.mts",
);
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
const DEFAULT_DOCKER_HUB_CLEANUP_ACTION_PATH = join(
  REPO_ROOT,
  ".github",
  "actions",
  "docker-auth-cleanup",
  "action.yaml",
);
const DEFAULT_DOCKER_HUB_CLEANUP_SCRIPT_PATH = join(
  REPO_ROOT,
  ".github",
  "scripts",
  "docker-auth-cleanup.sh",
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
const REVIEWED_HERMES_PLATFORM_ACTION = "./.github/actions/resolve-reviewed-hermes-platform";
const TRUSTED_MULTIARCH_HERMES_PLATFORM_ACTION =
  "./.trusted-hermes-resolver/.github/actions/resolve-reviewed-hermes-platform";

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
  coverageRows: E2eExecutionRow[];
}

export interface FocusedE2eJob {
  id: string;
  matchedFiles: string[];
}

export interface StagingBrevLaunchableDispatchEvaluation {
  runLaunchableE2e: boolean;
}

type CachedFreeStandingJobsInventory = {
  mtimeMs: number;
  size: number;
  inventory: FreeStandingJobsInventory;
};

const SELECTOR_PATTERN = /^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$/;
const SELECTOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const RETIRED_CONTROLLER_SELECTOR_IDS = [
  "credential-migration",
  "credential-sanitization",
  "diagnostics",
  "docs-validation",
  "gateway-drift-preflight",
  "gateway-health-honest",
  "onboard-negative-paths",
  "openshell-version-pin",
  "sandbox-rebuild",
  "ubuntu-repo-cli-smoke",
  "upgrade-stale-sandbox",
] as const;
export const RETIRED_CONTROLLER_TARGET_SELECTOR_IDS = [
  "sandbox-rebuild",
  "upgrade-stale-sandbox",
] as const;
const LIVE_TEST_FILE_PATTERN = /test\/e2e\/live\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.test\.ts/g;
const FREE_STANDING_JOB_MARKER = "E2E_JOB";
const FREE_STANDING_TARGET_MARKER = "E2E_TARGET_ID";
const FREE_STANDING_DEFAULT_ENABLED_MARKER = "E2E_DEFAULT_ENABLED";
const AGENT_RUNTIME_MARKER = "E2E_AGENT_RUNTIME";
const OUTCOME_MARKER = "E2E_OBSERVABLE_OUTCOME";
const ENVIRONMENT_MARKER = "E2E_ENVIRONMENT_OR_INFERENCE_ENDPOINT";
const UNRESOLVED_MARKER = "E2E_UNRESOLVED_REASON";
const COVERAGE_MATRIX_KEYS = [
  "agent_runtime",
  "observable_outcome",
  "environment_or_inference_endpoint",
  "unresolved_reason",
  "coverage_variant",
] as const;
const STAGING_BREV_JOB_ID = "staging-brev-launchable";
const STAGING_BREV_IDENTITY_JOB_ID = "staging-brev-launchable-identity";
const STAGING_BREV_JOB_IDS = new Set([STAGING_BREV_JOB_ID, STAGING_BREV_IDENTITY_JOB_ID]);
const COMMON_SECRET_ENV_NAMES = [
  "NVIDIA_API_KEY",
  "NVIDIA_INFERENCE_API_KEY",
  "DOCKERHUB_USERNAME",
  "DOCKERHUB_TOKEN",
  "GITHUB_TOKEN",
];
const FREE_STANDING_SELECTOR_SPECIAL_CASES = new Set([
  "hermes-e2e",
  "hermes-gpu-startup",
  "jetson-nvmap-gpu",
  "llama-cpp-dgx-spark-qualification",
  "managed-image-multiarch-startup",
  "managed-image-protected-runtime",
  "openshell-credential-generation-window",
  "staging-brev-launchable",
  "staging-brev-launchable-identity",
]);
const ADAPTER_MANAGED_INFERENCE_JOBS = new Set(["hermes-e2e"]);
const PUBLIC_NVIDIA_ENDPOINT_KEY_JOBS = new Set([
  "device-auth-health",
  "model-router-provider-routed-inference",
]);
const NO_IMAGE_E2E_JOBS = new Set([
  "staging-brev-launchable",
  "staging-brev-launchable-identity",
  SHARED_E2E_JOB_ID,
]);
const DOCKER_HUB_AUTH_STEP = "Authenticate to Docker Hub";
const DOCKER_HUB_CLEANUP_STEP = "Clean up Docker auth";
const DOCKER_HUB_CLEANUP_RUN = "bash .github/scripts/docker-auth-cleanup.sh";
const DOCKER_HUB_AUTH_PROVENANCE = E2E_ACTION_PROVENANCE.dockerAuth;
const DOCKER_HUB_CLEANUP_PROVENANCE = E2E_ACTION_PROVENANCE.dockerCleanup;
const DOCKER_HUB_AUTH_USES = DOCKER_HUB_AUTH_PROVENANCE.reference;
const HOST_DEPENDENCY_ACTION_PROVENANCE = E2E_ACTION_PROVENANCE.hostDependencies;
const HOST_DEPENDENCY_ACTION_USES = HOST_DEPENDENCY_ACTION_PROVENANCE.reference;
const DOCKER_HUB_CLEANUP_KEYS = ["if", "name", "run", "shell"];
// The general E2E workflow runs on push/manual dispatch. Its event set is
// intentionally distinct from the reusable image workflow's push/manual boundary.
const TRUSTED_DOCKER_HUB_PREDICATE =
  "github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && (inputs.checkout_sha == '' || needs.generate-matrix.outputs.e2e_credentials_allowed == 'true')";
const GUARDED_DOCKER_HUB_AUTH_REQUIRED = `\${{ ${TRUSTED_DOCKER_HUB_PREDICATE} && '1' || '0' }}`;
const GUARDED_DOCKER_HUB_USERNAME = `\${{ ${TRUSTED_DOCKER_HUB_PREDICATE} && secrets.DOCKERHUB_USERNAME || '' }}`;
const GUARDED_DOCKER_HUB_TOKEN = `\${{ ${TRUSTED_DOCKER_HUB_PREDICATE} && secrets.DOCKERHUB_TOKEN || '' }}`;
const GUARDED_HERMES_E2E_INFERENCE_KEY = `\${{ github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && (inputs.checkout_sha == '' || needs.generate-matrix.outputs.e2e_credentials_allowed == 'true') && (inputs.inference_mode || 'mock') != 'mock' && secrets.NVIDIA_INFERENCE_API_KEY || '' }}`;
const RUNNER_ROUTING_OUTPUT = "${{ steps.runner_routing.outputs.runner_routing }}";
const RUNNER_ROUTING_STEP_NAME = "Build trusted larger-runner routing";
const RUNNER_ROUTING_SCRIPT = [
  "set -euo pipefail",
  'larger_runner="ubuntu-latest"',
  'if [[ "${REPOSITORY}" == "NVIDIA/NemoClaw" && "${REF}" == "refs/heads/main" && -z "${CHECKOUT_SHA}" && -n "${LARGER_RUNNER_LABEL}" ]]; then',
  '  if [[ ! "${LARGER_RUNNER_LABEL}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then',
  '    echo "::error::E2E_LARGER_RUNNER_LABEL must be a 1-64 character workflow label using letters, digits, dots, underscores, or hyphens" >&2',
  "    exit 1",
  "  fi",
  '  larger_runner="${LARGER_RUNNER_LABEL}"',
  "fi",
  'runner_routing="$(jq -cn --arg standard "ubuntu-latest" --arg larger "${larger_runner}" \'{"channels-stop-start-hermes":$larger,"common-egress-agent":$larger,"hermes-discord":$larger,"hermes-e2e":$larger,"hermes-inference-switch":$larger,"hermes-shields-config":$larger,"mcp-bridge-deepagents":$larger,"mcp-bridge-hermes":$larger,"mcp-bridge-openclaw":$standard,"rebuild-hermes":$larger,"rebuild-hermes-stale-base":$larger,"security-posture-hermes":$larger}\')"',
  'printf \'runner_routing=%s\\n\' "${runner_routing}" >> "${GITHUB_OUTPUT}"',
].join("\n");
const ROUTED_JOB_RUNNER_EXPRESSIONS = {
  "hermes-e2e": "${{ fromJSON(needs.generate-matrix.outputs.runner_routing)['hermes-e2e'] }}",
} as const;
const MATRIX_ROUTED_JOB_RUNNER_EXPRESSIONS = {
  "mcp-bridge":
    "${{ fromJSON(needs.generate-matrix.outputs.runner_routing)[format('mcp-bridge-{0}', matrix.agent)] }}",
} as const;
const CATALOGUE_ROUTED_JOB_NAMES = [
  "catalogue-standard",
  "catalogue-nvidia-api",
  "catalogue-nvidia-inference",
  "catalogue-github-read",
  "catalogue-brave-nvidia-inference",
] as const;
const CATALOGUE_RUNNER_EXPRESSION =
  "${{ matrix.runner_key != '' && fromJSON(needs.generate-matrix.outputs.runner_routing)[matrix.runner_key] || matrix.runner }}";
const COMMON_EGRESS_AGENT_SCENARIO_MATRIX = {
  include: [
    {
      scenario: "openclaw-balanced-weather",
      selector: "^common-egress.+C1.+$",
    },
    {
      scenario: "openclaw-open-reference",
      selector: "^common-egress.+C2.+$",
    },
    {
      scenario: "hermes-open-reference",
      selector: "^common-egress.+C3.+$",
    },
  ],
} as const;
const ROUTED_JOB_NAMES = new Set([
  ...Object.keys(ROUTED_JOB_RUNNER_EXPRESSIONS),
  ...Object.keys(MATRIX_ROUTED_JOB_RUNNER_EXPRESSIONS),
  ...CATALOGUE_ROUTED_JOB_NAMES,
]);

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

export function validateDockerHubCleanupAction(
  actionPath = DEFAULT_DOCKER_HUB_CLEANUP_ACTION_PATH,
  scriptPath = DEFAULT_DOCKER_HUB_CLEANUP_SCRIPT_PATH,
): string[] {
  const actionSource = readFileSync(actionPath, "utf8");
  const scriptSource = readFileSync(scriptPath, "utf8");
  const errors: string[] = [];

  if (
    createHash("sha256").update(actionSource).digest("hex") !==
    DOCKER_HUB_CLEANUP_PROVENANCE.actionSha256
  ) {
    errors.push("docker-auth-cleanup action content must match the pinned commit");
  }
  if (
    createHash("sha256").update(scriptSource).digest("hex") !==
    DOCKER_HUB_CLEANUP_PROVENANCE.scriptSha256
  ) {
    errors.push("docker-auth-cleanup script content must match the pinned commit");
  }

  const expectedAction = {
    name: "docker-auth-cleanup",
    description: "Remove isolated Docker Hub credentials with validated path checks.",
    runs: {
      using: "composite",
      steps: [
        {
          name: "Clean up Docker auth",
          shell: "bash",
          run: 'bash "${{ github.action_path }}/../../scripts/docker-auth-cleanup.sh"',
        },
      ],
    },
  };
  if (!isDeepStrictEqual(asRecord(YAML.parse(actionSource)), expectedAction)) {
    errors.push("docker-auth-cleanup action must invoke the helper through github.action_path");
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

function workflowCoverageRows(jobId: string, job: WorkflowRecord): E2eExecutionRow[] {
  const env = asRecord(job.env);
  const matrix = asRecord(asRecord(job.strategy).matrix);
  const includes = Array.isArray(matrix.include)
    ? matrix.include
        .map(asRecord)
        .filter((entry) => COVERAGE_MATRIX_KEYS.some((key) => Object.hasOwn(entry, key)))
    : [];
  const hasEnvironmentMetadata = [
    AGENT_RUNTIME_MARKER,
    OUTCOME_MARKER,
    ENVIRONMENT_MARKER,
    UNRESOLVED_MARKER,
  ].some((key) => Object.hasOwn(env, key));
  if (!hasEnvironmentMetadata && includes.length === 0) return [];

  const candidates = includes.length > 0 ? includes : [{}];
  return candidates.map((entry) => {
    const metadata = validateE2eExecutionMetadata(
      {
        agentRuntime: stringValue(entry.agent_runtime || env[AGENT_RUNTIME_MARKER]),
        observableOutcome: stringValue(entry.observable_outcome || env[OUTCOME_MARKER]),
        environmentOrInferenceEndpoint: stringValue(
          entry.environment_or_inference_endpoint || env[ENVIRONMENT_MARKER],
        ),
        unresolvedReason: stringValue(entry.unresolved_reason || env[UNRESOLVED_MARKER]),
      } as Parameters<typeof validateE2eExecutionMetadata>[0],
      `E2E workflow job ${jobId}`,
    );
    return {
      id: jobId,
      variant: stringValue(entry.coverage_variant),
      source: STAGING_BREV_JOB_IDS.has(jobId) ? "staging" : "retained-workflow",
      ...metadata,
    };
  });
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
  const coverageRows: E2eExecutionRow[] = [];

  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob);
    const env = asRecord(job.env);
    try {
      coverageRows.push(...workflowCoverageRows(jobId, job));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
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
  for (const jobId of workflowJobs) {
    if (jobId !== SHARED_E2E_JOB_ID && !coverageRows.some((row) => row.id === jobId)) {
      errors.push(`${jobId} job requires execution coverage metadata`);
    }
  }
  if (
    Object.hasOwn(jobs, STAGING_BREV_JOB_ID) &&
    !coverageRows.some((row) => row.source === "staging")
  ) {
    errors.push(`${STAGING_BREV_JOB_ID} job requires execution coverage metadata`);
  }
  try {
    validateE2eExecutionRows(coverageRows);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    errors,
    inventory: {
      allowedJobs,
      workflowJobs,
      explicitOnlyJobs,
      freeStandingTargets,
      targetToJob,
      coverageRows,
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
    coverageRows: inventory.coverageRows.map((row) => ({ ...row })),
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

const RESTORED_GATEWAY_PAIRING_RUNTIME_FILES = new Set([
  "src/lib/actions/sandbox/auto-pair-approval.ts",
  "src/lib/actions/sandbox/restore-gateway-pairing.ts",
  "src/lib/adapters/openshell/restore-gateway-pairing.ts",
]);
const LIVE_E2E_OWNING_FILE_JOBS = new Map<string, readonly string[]>([
  ["test/e2e/live/openclaw-plugin-runtime-exdev-lifecycle.ts", ["openclaw-plugin-runtime-exdev"]],
]);

export function focusedE2eJobsForChangedFiles(
  changedFiles: readonly string[],
  inventory: FreeStandingJobsInventory = readFreeStandingJobsInventory(),
): FocusedE2eJob[] {
  const matchedFilesByJob = new Map<string, string[]>();
  for (const file of [...new Set(changedFiles)].sort((left, right) => left.localeCompare(right))) {
    for (const job of inventory.liveTestToJobs.get(file) ?? []) {
      addMapValue(matchedFilesByJob, job, file);
    }
    for (const job of LIVE_E2E_OWNING_FILE_JOBS.get(file) ?? []) {
      if (inventory.allowedJobs.includes(job)) addMapValue(matchedFilesByJob, job, file);
    }
    if (RESTORED_GATEWAY_PAIRING_RUNTIME_FILES.has(file)) {
      addMapValue(matchedFilesByJob, "snapshot-commands", file);
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
  const jobsMatchSelectorPattern = !jobs || SELECTOR_PATTERN.test(jobs);
  const normalizedJobs = jobsMatchSelectorPattern
    ? normalizeE2eSelectorIds(splitSelector(jobs))
    : [];

  if (targets && !SELECTOR_PATTERN.test(targets)) {
    errors.push("Invalid target input");
  }
  if (!jobsMatchSelectorPattern) {
    errors.push("Invalid jobs input");
  }
  for (const job of normalizedJobs) {
    if (!freeStandingJobIds.includes(job)) {
      errors.push(`Unknown free-standing E2E job: ${job}`);
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

  const selectedFreeStandingJobs = new Set(normalizedJobs);
  const registryTargets: string[] = [];
  for (const target of normalizeE2eSelectorIds(splitSelector(targets))) {
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

export function evaluateStagingBrevLaunchableDispatch(input: {
  eventName: "push" | "workflow_dispatch";
  includeStagingBrevLaunchable?: boolean;
  jobs?: string;
  targets?: string;
  trustedMain?: boolean;
}): StagingBrevLaunchableDispatchEvaluation {
  const jobs = input.jobs ?? "";
  const targets = input.targets ?? "";
  const fullDispatch =
    input.eventName === "workflow_dispatch" &&
    input.includeStagingBrevLaunchable === true &&
    jobs === "" &&
    targets === "";
  const explicitlySelected =
    input.eventName === "workflow_dispatch" && jobs === "staging-brev-launchable" && targets === "";
  const requested = fullDispatch || explicitlySelected;
  const trustedMain = input.trustedMain !== false;

  return {
    runLaunchableE2e: requested && trustedMain,
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

function validateLargerRunnerRouting(
  errors: string[],
  jobs: WorkflowRecord,
  generateMatrix: WorkflowRecord,
  generateSteps: readonly WorkflowStep[],
  generateCheckout: WorkflowStep | undefined,
): void {
  const generateOutputs = asRecord(generateMatrix.outputs);
  if (generateOutputs.runner_routing !== RUNNER_ROUTING_OUTPUT) {
    errors.push("generate-matrix job must expose the trusted larger-runner routing output");
  }

  const routing = requireJobStep(
    errors,
    "generate-matrix",
    generateSteps,
    RUNNER_ROUTING_STEP_NAME,
  );
  if (!routing) return;
  if (routing.id !== "runner_routing") {
    errors.push("trusted larger-runner routing step must use id runner_routing");
  }
  if (routing.if !== undefined) {
    errors.push("trusted larger-runner routing step must always publish the fallback map");
  }
  if (routing.shell !== "bash") {
    errors.push("trusted larger-runner routing step must use bash");
  }
  const expectedEnv = {
    CHECKOUT_SHA: "${{ inputs.checkout_sha }}",
    LARGER_RUNNER_LABEL: "${{ vars.E2E_LARGER_RUNNER_LABEL }}",
    REF: "${{ github.ref }}",
    REPOSITORY: "${{ github.repository }}",
  };
  if (!isDeepStrictEqual(asRecord(routing.env), expectedEnv)) {
    errors.push(
      "trusted larger-runner routing step must bind only the administrator label and trusted repository identity",
    );
  }
  if (stringValue(routing.run).trimEnd() !== RUNNER_ROUTING_SCRIPT) {
    errors.push(
      "trusted larger-runner routing step must preserve the exact main-only map and ubuntu-latest fallback",
    );
  }
  if (
    generateCheckout &&
    generateSteps.indexOf(routing) >= generateSteps.indexOf(generateCheckout)
  ) {
    errors.push("trusted larger-runner routing step must run before PR checkout");
  }

  for (const [jobName, expected] of Object.entries(ROUTED_JOB_RUNNER_EXPRESSIONS)) {
    if (asRecord(jobs[jobName])["runs-on"] !== expected) {
      errors.push(`${jobName} job must use the trusted larger-runner routing map`);
    }
  }
  for (const [jobName, expected] of Object.entries(MATRIX_ROUTED_JOB_RUNNER_EXPRESSIONS)) {
    if (asRecord(jobs[jobName])["runs-on"] !== expected) {
      errors.push(`${jobName} job must route each matrix entry through the trusted runner map`);
    }
  }
  for (const jobName of CATALOGUE_ROUTED_JOB_NAMES) {
    if (asRecord(asRecord(jobs[jobName]).with).runner !== CATALOGUE_RUNNER_EXPRESSION) {
      errors.push(`${jobName} job must route catalogue runners through the trusted runner map`);
    }
  }
  if (asRecord(jobs["mcp-bridge-dev"])["runs-on"] !== "ubuntu-latest") {
    errors.push("mcp-bridge-dev job must remain on ubuntu-latest");
  }

  for (const [jobName, jobValue] of Object.entries(jobs)) {
    if (
      jobName !== "generate-matrix" &&
      JSON.stringify(jobValue).includes("needs.generate-matrix.outputs.runner_routing") &&
      !ROUTED_JOB_NAMES.has(jobName)
    ) {
      errors.push(`${jobName} job must not use the larger-runner routing map`);
    }
    if (
      jobName !== "generate-matrix" &&
      JSON.stringify(jobValue).includes("vars.E2E_LARGER_RUNNER_LABEL")
    ) {
      errors.push(`${jobName} job must not consume E2E_LARGER_RUNNER_LABEL directly`);
    }
  }
  for (const step of generateSteps) {
    if (step !== routing && JSON.stringify(step).includes("vars.E2E_LARGER_RUNNER_LABEL")) {
      errors.push(
        "only the trusted larger-runner routing step may consume E2E_LARGER_RUNNER_LABEL",
      );
    }
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

function requirePushRun(errors: string[], triggers: WorkflowRecord): void {
  const push = asRecord(triggers.push);
  const branches = Array.isArray(push.branches) ? push.branches : [];
  if (!branches.includes("main")) {
    errors.push("workflow push trigger must include main");
  }
}

function rejectUnexpectedTriggers(errors: string[], triggers: WorkflowRecord): void {
  for (const unsafe of ["schedule", "pull_request", "pull_request_target"]) {
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

function isReviewedLocalHermesPlatformAction(jobName: string, step: WorkflowStep): boolean {
  return (
    (jobName === "managed-image-multiarch-startup" &&
      step.name === "Resolve reviewed Hermes platform base image" &&
      step.uses === TRUSTED_MULTIARCH_HERMES_PLATFORM_ACTION) ||
    (jobName === "managed-image-protected-runtime" &&
      step.name === "Resolve reviewed Hermes runtime base image" &&
      step.uses === REVIEWED_HERMES_PLATFORM_ACTION)
  );
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

function selectedJobsCondition(jobName: string): string {
  return `\${{ contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), '${jobName}') }}`;
}

function validateFreeStandingJobSelector(
  errors: string[],
  jobs: WorkflowRecord,
  jobName: string,
  _targetName?: string,
  _explicitOnly = false,
): void {
  const job = asRecord(jobs[jobName]);
  const expectedNeeds =
    jobName === "mcp-bridge-dev"
      ? ["generate-matrix", "openshell-dev-artifact"]
      : "generate-matrix";
  if (!isDeepStrictEqual(job.needs, expectedNeeds)) {
    errors.push(`${jobName} job must depend on generate-matrix`);
  }
  if (job.if !== selectedJobsCondition(jobName)) {
    errors.push(`${jobName} job must use the shared jobs selector condition`);
  }
}

function validateCatalogueOwnedJobs(errors: string[], jobs: WorkflowRecord): void {
  for (const jobName of ["gpu-double-onboard", "gpu-e2e", "llama-cpp-generic-gpu"]) {
    if (Object.hasOwn(jobs, jobName)) {
      errors.push(`${jobName} must run through the catalogue execution profile`);
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
      if (step.uses && !isReviewedLocalHermesPlatformAction(jobName, step)) {
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
    const specialSelector =
      FREE_STANDING_SELECTOR_SPECIAL_CASES.has(jobId) &&
      jobIf.includes("fromJSON(needs.generate-matrix.outputs.selected_jobs)") &&
      jobIf.includes(`'${jobId}'`);
    const mappingIsRepresented =
      jobIf === selectedJobsCondition(jobId) ||
      specialSelector ||
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
      "canonical Docker Hub auth must gate auth-required on the trusted repository, main ref, and push/manual events",
    );
  }
  if (authWith.username !== GUARDED_DOCKER_HUB_USERNAME) {
    errors.push(
      "canonical Docker Hub auth must gate username on the trusted repository, main ref, and push/manual events",
    );
  }
  if (authWith.token !== GUARDED_DOCKER_HUB_TOKEN) {
    errors.push(
      "canonical Docker Hub auth must gate token on the trusted repository, main ref, and push/manual events",
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
      return env.E2E_JOB === "1" || NO_IMAGE_E2E_JOBS.has(jobName);
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

    const workflowSteps = asSteps(job.steps);
    const authSteps = workflowSteps.filter((step) => step.name === DOCKER_HUB_AUTH_STEP);
    const cleanupSteps = workflowSteps.filter((step) => step.name === DOCKER_HUB_CLEANUP_STEP);
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

    const checkoutIndexes = workflowSteps.flatMap((step, index) => {
      if (jobName === "managed-image-protected-runtime") {
        return step.name === "Checkout exact protected runtime candidate source" ? [index] : [];
      }
      if (jobName === "managed-image-multiarch-startup") {
        return step.name === "Checkout trusted Hermes resolver" ? [index] : [];
      }
      if (jobName === "llama-cpp-dgx-spark-qualification") {
        return step.name === "Checkout exact llama.cpp qualification candidate" ? [index] : [];
      }
      return stringValue(step.uses).startsWith("actions/checkout@") ? [index] : [];
    });
    const checkoutIndex = checkoutIndexes[0] ?? -1;
    const protectedCacheDownloadIndex =
      jobName === "managed-image-protected-runtime"
        ? workflowSteps.findIndex(
            (step) => step.name === "Download exact protected runtime build cache",
          )
        : -1;
    const authIndex = workflowSteps.indexOf(auth);
    const cleanupIndex = workflowSteps.indexOf(cleanup);
    const expectedAuthIndex =
      jobName === "hermes-gpu-startup"
        ? checkoutIndex + 3
        : jobName === "managed-image-protected-runtime"
          ? protectedCacheDownloadIndex + 1
          : checkoutIndex + 1;
    if (
      checkoutIndex < 0 ||
      (jobName === "managed-image-protected-runtime" && protectedCacheDownloadIndex < 0) ||
      authIndex !== expectedAuthIndex
    ) {
      errors.push(
        jobName === "managed-image-protected-runtime"
          ? `${jobName} Docker Hub auth must run immediately after the protected cache download`
          : `${jobName} Docker Hub auth must run immediately after checkout`,
      );
    }
    if (authIndex < 0 || cleanupIndex <= authIndex) {
      errors.push(`${jobName} Docker Hub cleanup must run after authentication and test work`);
    }
    if (cleanupIndex !== workflowSteps.length - 1) {
      errors.push(`${jobName} Docker Hub cleanup must be the final job step`);
    }

    for (const step of workflowSteps) {
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
    const workflowSteps = asSteps(asRecord(jobs[jobName]).steps);
    if (
      namedStep(workflowSteps, DOCKER_HUB_AUTH_STEP) ||
      namedStep(workflowSteps, DOCKER_HUB_CLEANUP_STEP)
    ) {
      errors.push(`${jobName} no-image job must not receive Docker Hub authentication`);
    }
  }

  const classifiedJobNames = new Set([...imageJobNames, ...NO_IMAGE_E2E_JOBS]);
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    if (classifiedJobNames.has(jobName)) continue;
    const workflowSteps = asSteps(asRecord(rawJob).steps);
    if (
      namedStep(workflowSteps, DOCKER_HUB_AUTH_STEP) ||
      namedStep(workflowSteps, DOCKER_HUB_CLEANUP_STEP)
    ) {
      errors.push(`${jobName} non-E2E job must not own the shared Docker Hub auth aliases`);
    }
  }
}
function validateHermesE2EJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = "hermes-e2e";
  const job = asRecord(jobs[jobName]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing hermes-e2e job");
    return;
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
      "hermes-e2e run step must guard NVIDIA_INFERENCE_API_KEY behind a direct main dispatch or an authorized NVIDIA-owned PR dispatch, plus the inference mode condition",
    );
  }
  requireRunContains(errors, runVitest, "tools/e2e/live-vitest-invocation.mts run --test-path");
  requireRunContains(errors, runVitest, "test/e2e/live/hermes-e2e.test.ts");
  requireRunDoesNotContain(errors, runVitest, "${{ inputs.");
}

function validateHermesTimeoutHeadroom(errors: string[], jobs: WorkflowRecord): void {
  for (const {
    innerTest,
    innerTimeoutMinutes,
    jobName,
    jobTimeoutMinutes,
  } of HERMES_TIMEOUT_CONTRACTS) {
    const actualJobTimeoutMinutes = asRecord(jobs[jobName])["timeout-minutes"];
    const maximumJobTimeoutMinutes = innerTimeoutMinutes + HERMES_TIMEOUT_HEADROOM_MAX_MINUTES;
    if (
      !Number.isInteger(actualJobTimeoutMinutes) ||
      (actualJobTimeoutMinutes as number) < jobTimeoutMinutes ||
      (actualJobTimeoutMinutes as number) > maximumJobTimeoutMinutes
    ) {
      errors.push(
        `${jobName} timeout must be between ${jobTimeoutMinutes} and ${maximumJobTimeoutMinutes} minutes to cover the ${innerTimeoutMinutes}-minute Vitest timeout in ${innerTest} with ${HERMES_TIMEOUT_HEADROOM_MINUTES}-${HERMES_TIMEOUT_HEADROOM_MAX_MINUTES} minutes of job headroom`,
      );
    }
  }
}

function validateAllowJetsonDispatchInput(errors: string[], dispatchInputs: WorkflowRecord): void {
  const input = requireInput(errors, dispatchInputs, "allow_jetson_dispatch");
  if (input.type !== "boolean") {
    errors.push("workflow_dispatch allow_jetson_dispatch input must be boolean");
  }
  if (input.default !== false) {
    errors.push("workflow_dispatch allow_jetson_dispatch input must default to false");
  }
  const description = stringValue(input.description);
  if (
    !description.includes("operator-owned dispatch backend") ||
    !description.includes("JETSON_DISPATCH_URL") ||
    !description.includes("test/e2e/docs/jetson-dispatch.md")
  ) {
    errors.push(
      "workflow_dispatch allow_jetson_dispatch input must require the operator-owned backend, repository URL variable, and controller documentation",
    );
  }
}

function validateJetsonControllerBoundary(errors: string[], jobs: WorkflowRecord): void {
  const job = asRecord(jobs["jetson-nvmap-gpu"]);
  if (job.needs !== "generate-matrix") {
    errors.push("jetson-nvmap-gpu job must depend on generate-matrix");
  }
  const trustedPushOrManualSelector =
    "${{ github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.allow_jetson_dispatch && (inputs.checkout_repository == '' || inputs.checkout_repository == github.repository) && ((inputs.jobs == '' && inputs.targets == '') || contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'jetson-nvmap-gpu')))) }}";
  if (job.if !== trustedPushOrManualSelector) {
    errors.push(
      "jetson-nvmap-gpu job must run on trusted main pushes and require opt-in for same-repository manual selections",
    );
  }
  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push("jetson-nvmap-gpu controller must use a GitHub-hosted runner");
  }
  if (job["timeout-minutes"] !== 60)
    errors.push("jetson-nvmap-gpu controller timeout must be 60 minutes");
  if (
    !isDeepStrictEqual(asRecord(job.concurrency), {
      group: "jetson-nvmap-gpu-dispatch",
      "cancel-in-progress": false,
    })
  ) {
    errors.push(
      "jetson-nvmap-gpu concurrency must preserve its operator-backend group without cancellation",
    );
  }
  if (!isDeepStrictEqual(asRecord(job.permissions), { contents: "read", "id-token": "write" })) {
    errors.push("jetson-nvmap-gpu controller must grant only contents:read and id-token:write");
  }
  if (Object.keys(asRecord(job.env)).length !== 0) {
    errors.push("jetson-nvmap-gpu controller must not define a job-level environment");
  }

  const steps = asSteps(job.steps);
  const checkout = namedStep(steps, "Check out trusted Jetson controller");
  if (!checkout || !stringValue(checkout.uses).startsWith("actions/checkout@")) {
    errors.push("jetson-nvmap-gpu controller must check out the trusted workflow source");
  } else {
    requireFullShaAction(errors, checkout, "jetson-nvmap-gpu trusted checkout");
    if (
      !isDeepStrictEqual(asRecord(checkout.with), {
        repository: "NVIDIA/NemoClaw",
        ref: "${{ github.workflow_sha }}",
        "persist-credentials": false,
      })
    ) {
      errors.push(
        "jetson-nvmap-gpu checkout must use the trusted workflow SHA without credentials",
      );
    }
  }
  const setupNode = namedStep(steps, "Set up Node for Jetson controller");
  if (!setupNode || !stringValue(setupNode.uses).startsWith("actions/setup-node@")) {
    errors.push("jetson-nvmap-gpu controller must set up Node.js");
  } else {
    requireFullShaAction(errors, setupNode, "jetson-nvmap-gpu Node setup");
    if (asRecord(setupNode.with)["node-version"] !== 22) {
      errors.push("jetson-nvmap-gpu controller must use Node.js 22");
    }
  }
  const dispatch = namedStep(steps, "Dispatch exact commit to Jetson through operator backend");
  if (
    dispatch?.run !==
      "node --experimental-strip-types --no-warnings tools/e2e/jetson-dispatch-client.mts" ||
    !isDeepStrictEqual(asRecord(dispatch?.env), {
      E2E_ARTIFACT_DIR: "${{ runner.temp }}/e2e-artifacts/live/jetson-nvmap-gpu",
      JETSON_DISPATCH_CANDIDATE_SHA: "${{ inputs.checkout_sha || github.sha }}",
      JETSON_DISPATCH_URL: "${{ vars.JETSON_DISPATCH_URL }}",
    })
  ) {
    errors.push(
      "jetson-nvmap-gpu controller must dispatch only the exact candidate and configured URL",
    );
  }
  const upload = namedStep(steps, "Upload Jetson nvmap GPU artifacts");
  if (
    upload?.if !== "always()" ||
    upload.uses !== UPLOAD_E2E_ARTIFACTS_ACTION ||
    !isDeepStrictEqual(asRecord(upload.with), {
      name: "e2e-jetson-nvmap-gpu",
      path: "${{ runner.temp }}/e2e-artifacts/live/jetson-nvmap-gpu/",
    })
  ) {
    errors.push("jetson-nvmap-gpu controller must upload its bounded dispatch artifact");
  }
  if (steps.length !== 4) {
    errors.push(
      "jetson-nvmap-gpu controller must contain only checkout, Node setup, dispatch, and upload",
    );
  }
}

export function validateJetsonDispatchBoundary(workflow: unknown): string[] {
  const workflowRecord = asRecord(workflow);
  const triggers = asRecord(workflowRecord.on ?? workflowRecord[true as unknown as string]);
  const workflowDispatch = asRecord(triggers.workflow_dispatch);
  const errors: string[] = [];

  validateAllowJetsonDispatchInput(errors, asRecord(workflowDispatch.inputs));
  validateJetsonControllerBoundary(errors, asRecord(workflowRecord.jobs));
  return errors;
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

function validateFullE2eConcurrency(errors: string[], workflow: WorkflowRecord): void {
  const concurrency = asRecord(workflow.concurrency);
  const expectedGroup =
    "e2e-${{ github.ref }}-${{ inputs.checkout_sha != '' && format('pr-{0}', inputs.pr_number) || (inputs.include_staging_brev_launchable && inputs.jobs == '' && inputs.targets == '' && format('full-{0}', github.run_id)) || inputs.targets || 'supported' }}-${{ inputs.checkout_sha != '' && 'manual-pr' || inputs.jobs || 'all-jobs' }}";
  if (concurrency.group !== expectedGroup) {
    errors.push("workflow concurrency must isolate each full dispatch with github.run_id");
  }
  if (
    concurrency["cancel-in-progress"] !==
    "${{ inputs.checkout_sha != '' && !inputs.allow_jetson_dispatch && !contains(format(',{0},', inputs.jobs), ',staging-brev-launchable,') && !contains(format(',{0},', inputs.jobs), ',staging-brev-launchable-identity,') && !inputs.include_staging_brev_launchable }}"
  ) {
    errors.push("workflow concurrency must not cancel an active Jetson or Launchable dispatch");
  }
}

function validateStagingBrevLaunchableJob(errors: string[], jobs: WorkflowRecord): void {
  const job = asRecord(jobs["staging-brev-launchable"]);
  if (job.name !== "Exact staging Brev Launchable") {
    errors.push("staging-brev-launchable must identify the exact Launchable E2E contract");
  }
  if (job.needs !== "generate-matrix") {
    errors.push("staging-brev-launchable must depend on the authorized generate-matrix job");
  }
  if (Object.hasOwn(job, "environment")) {
    errors.push("staging-brev-launchable must not use a GitHub environment");
  }
  const trustedRun = "github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main'";
  if (
    !stringValue(job.if).includes(trustedRun) ||
    stringValue(job.if).includes("checkout_sha == ''")
  ) {
    errors.push("staging-brev-launchable must allow only trusted-main dispatches");
  }
  const expectedSelector =
    "${{ github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && ((inputs.jobs == 'staging-brev-launchable' && inputs.targets == '') || (inputs.include_staging_brev_launchable && inputs.jobs == '' && inputs.targets == '')) }}";
  if (job.if !== expectedSelector) {
    errors.push("staging-brev-launchable must retain trusted manual selection");
  }
  const generateMatrix = asRecord(jobs["generate-matrix"]);
  const generateSteps = asSteps(generateMatrix.steps);
  const authorization = requireJobStep(
    errors,
    "generate-matrix",
    generateSteps,
    "Authorize Launchable E2E maintainer dispatch",
  );
  const expectedAuthorizationSelector =
    "${{ github.event_name == 'workflow_dispatch' && inputs.checkout_sha == '' && ((inputs.jobs == 'staging-brev-launchable' && inputs.targets == '') || (inputs.jobs == 'staging-brev-launchable-identity' && inputs.targets == '') || (inputs.include_staging_brev_launchable && inputs.jobs == '' && inputs.targets == '')) }}";
  if (authorization?.if !== expectedAuthorizationSelector) {
    errors.push("Launchable E2E maintainer authorization must cover exact and full dispatches");
  }
  if (authorization?.shell !== "bash") {
    errors.push("Launchable E2E maintainer authorization must use bash");
  }
  const authorizationEnv = asRecord(authorization?.env);
  for (const [key, expected] of [
    ["ACTOR", "${{ github.actor }}"],
    ["GITHUB_TOKEN", "${{ github.token }}"],
    ["TRIGGERING_ACTOR", "${{ github.triggering_actor }}"],
  ] as const) {
    if (authorizationEnv[key] !== expected) {
      errors.push(`Launchable E2E maintainer authorization must bind ${key}`);
    }
  }
  for (const required of [
    "/collaborators/${maintainer}/permission",
    "'.user.login // \"\"'",
    "'.role_name // \"\"'",
    "maintain | admin",
    'require_maintainer "$ACTOR"',
    'require_maintainer "$TRIGGERING_ACTOR"',
    "requires a repository maintainer or administrator",
  ]) {
    requireRunContains(errors, authorization, required);
  }
  const generateCheckout = namedStep(generateSteps, "Check out E2E candidate");
  if (
    authorization &&
    generateCheckout &&
    generateSteps.indexOf(authorization) >= generateSteps.indexOf(generateCheckout)
  ) {
    errors.push("Launchable E2E maintainer authorization must run before generate-matrix checkout");
  }
  const concurrency = asRecord(job.concurrency);
  if (
    concurrency.group !== "staging-brev-launchable-cpu" ||
    Object.hasOwn(concurrency, "queue") ||
    concurrency["cancel-in-progress"] !== false
  ) {
    errors.push(
      "staging-brev-launchable concurrency must preserve its Launchable group without cancelling the running job or using unsupported queue keys",
    );
  }
  const steps = asSteps(job.steps);
  const checkout = requireStep(errors, steps, "Checkout trusted Launchable lane");
  const checkoutWith = asRecord(checkout?.with);
  if (
    checkoutWith.ref !== "${{ github.workflow_sha }}" ||
    checkoutWith["persist-credentials"] !== false
  ) {
    errors.push(
      "staging-brev-launchable must check out trusted workflow source without credentials",
    );
  }
  const prepare = requireStep(errors, steps, "Prepare the trusted lane");
  const prepareEnv = asRecord(prepare?.env);
  const run = requireStep(errors, steps, "Build, deploy, verify, test, and clean up");
  if (run?.run !== "tools/e2e/brev-launchable-e2e.sh") {
    errors.push("staging-brev-launchable must execute the trusted Launchable E2E script");
  }
  if (prepare && run && steps.indexOf(prepare) >= steps.indexOf(run)) {
    errors.push("staging-brev-launchable must prepare the workspace before the Launchable E2E run");
  }
  const runEnv = asRecord(run?.env);
  for (const [env, key, secret] of [
    [prepareEnv, "BREV_API_KEY", "BREV_API_KEY"],
    [prepareEnv, "BREV_ORG_ID", "BREV_ORG_ID"],
    [runEnv, "GH_TOKEN", "NEMOCLAW_IMAGE_DISPATCH_TOKEN"],
    [runEnv, "NVIDIA_INFERENCE_API_KEY", "NVIDIA_INFERENCE_API_KEY"],
  ] as const) {
    const expected = `\${{ ${trustedRun} && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && secrets.${secret} || '' }}`;
    if (env[key] !== expected) {
      errors.push(`staging-brev-launchable ${key} must use the trusted-run secret guard`);
    }
  }
  if (runEnv.BREV_LAUNCHABLE_ID !== "${{ vars.NEMOCLAW_STAGING_LAUNCHABLE_ID }}") {
    errors.push("staging-brev-launchable must read the repository Launchable ID variable");
  }
  if (runEnv.WORK_DIR !== "${{ steps.workspace.outputs.work_dir }}") {
    errors.push("staging-brev-launchable must pass its private evidence directory to the lane");
  }
  if (Object.hasOwn(runEnv, "NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY")) {
    errors.push("staging-brev-launchable must not stop after image publication");
  }
  if (Object.hasOwn(runEnv, "NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY")) {
    errors.push("staging-brev-launchable must retain the full E2E contract");
  }
  const jobEnv = asRecord(job.env);
  for (const [env, scope, forbidden] of [
    [jobEnv, "job", ["BREV_API_KEY", "BREV_ORG_ID", "GH_TOKEN", "NVIDIA_INFERENCE_API_KEY"]],
    [prepareEnv, "preparation step", ["GH_TOKEN", "NVIDIA_INFERENCE_API_KEY"]],
    [runEnv, "execution step", ["BREV_API_KEY", "BREV_ORG_ID"]],
  ] as const) {
    for (const key of forbidden) {
      if (Object.hasOwn(env, key)) {
        errors.push(`staging-brev-launchable ${scope} must not receive ${key}`);
      }
    }
  }
  if (
    !/^0\.\d+\.\d+$/u.test(stringValue(prepareEnv.BREV_CLI_VERSION)) ||
    !/^[0-9a-f]{64}$/u.test(stringValue(prepareEnv.BREV_CLI_SHA256))
  ) {
    errors.push("staging-brev-launchable must pin the Brev CLI version and SHA-256 checksum");
  }
  const prepareRun = stringValue(prepare?.run);
  if (
    !prepareRun.includes("sha256sum -c -") ||
    !prepareRun.includes('brev login --api-key "$BREV_API_KEY" --org-id "$BREV_ORG_ID"')
  ) {
    errors.push("staging-brev-launchable must verify and authenticate the pinned Brev CLI");
  }
}

function validateStagingBrevLaunchableIdentityJob(errors: string[], jobs: WorkflowRecord): void {
  const jobName = STAGING_BREV_IDENTITY_JOB_ID;
  const job = asRecord(jobs[jobName]);
  if (job.name !== "Exact staging Brev Launchable identity") {
    errors.push(`${jobName} must identify the exact image and runtime identity contract`);
  }
  if (job.needs !== "generate-matrix") {
    errors.push(`${jobName} must depend only on the authorized generate-matrix job`);
  }
  if (job["timeout-minutes"] !== 180) {
    errors.push(`${jobName} must reserve the bounded 180 minute image, boot, and cleanup window`);
  }
  if (!isDeepStrictEqual(asRecord(job.permissions), { contents: "read" })) {
    errors.push(`${jobName} must grant only contents read permission`);
  }
  if (Object.hasOwn(job, "environment")) {
    errors.push(`${jobName} must not use a GitHub environment`);
  }
  const expectedSelector =
    "${{ github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && inputs.checkout_sha == '' && inputs.jobs == 'staging-brev-launchable-identity' && inputs.targets == '' }}";
  if (job.if !== expectedSelector) {
    errors.push(`${jobName} must run only when trusted main explicitly selects it`);
  }
  const concurrency = asRecord(job.concurrency);
  if (
    concurrency.group !== "staging-brev-launchable-cpu" ||
    Object.hasOwn(concurrency, "queue") ||
    concurrency["cancel-in-progress"] !== false
  ) {
    errors.push(`${jobName} must share the non-cancelling Launchable concurrency group`);
  }

  const jobEnv = asRecord(job.env);
  const expectedJobEnv = {
    CANDIDATE_SHA: "${{ github.sha }}",
    E2E_DEFAULT_ENABLED: "0",
    E2E_JOB: "1",
    INSTANCE_NAME: "nclaw-identity-${{ github.run_id }}-${{ github.run_attempt }}",
    E2E_AGENT_RUNTIME: "none",
    E2E_OBSERVABLE_OUTCOME:
      "Exact staging image boots, passes the SSH access probe, and matches the baked runtime identity",
    E2E_ENVIRONMENT_OR_INFERENCE_ENDPOINT: "Brev Launchable host; no inference endpoint",
  };
  if (!isDeepStrictEqual(jobEnv, expectedJobEnv)) {
    errors.push(`${jobName} job environment must match its reviewed identity-only contract`);
  }
  for (const [key, value] of Object.entries(expectedJobEnv)) {
    if (jobEnv[key] !== value) errors.push(`${jobName} must bind ${key} to its reviewed value`);
  }
  for (const secret of ["BREV_API_KEY", "BREV_ORG_ID", "GH_TOKEN", "NVIDIA_INFERENCE_API_KEY"]) {
    if (Object.hasOwn(jobEnv, secret)) {
      errors.push(`${jobName} job scope must not receive ${secret}`);
    }
  }

  const steps = asSteps(job.steps);
  const checkout = requireJobStep(
    errors,
    jobName,
    steps,
    "Checkout trusted Launchable identity lane",
  );
  const checkoutWith = asRecord(checkout?.with);
  if (
    checkoutWith.ref !== "${{ github.workflow_sha }}" ||
    checkoutWith["persist-credentials"] !== false ||
    checkoutWith["sparse-checkout"] !== "tools/e2e/brev-launchable-e2e.sh\n" ||
    checkoutWith["sparse-checkout-cone-mode"] !== false
  ) {
    errors.push(`${jobName} must check out only the trusted shared Launchable harness`);
  }
  if (!isDeepStrictEqual(asRecord(checkout?.env), {})) {
    errors.push(`${jobName} checkout step must not receive environment values`);
  }

  const prepare = requireJobStep(errors, jobName, steps, "Prepare the trusted identity lane");
  const execute = requireJobStep(errors, jobName, steps, "Build, boot, and verify identity");
  const resourceCleanup = requireJobStep(
    errors,
    jobName,
    steps,
    "Verify identity workspace cleanup",
  );
  const credentialCleanup = requireJobStep(errors, jobName, steps, "Remove Brev credentials");
  const upload = requireJobStep(errors, jobName, steps, "Upload Launchable identity evidence");
  const expectedStepNames = [
    "Checkout trusted Launchable identity lane",
    "Prepare the trusted identity lane",
    "Build, boot, and verify identity",
    "Verify identity workspace cleanup",
    "Remove Brev credentials",
    "Upload Launchable identity evidence",
  ];
  if (
    !isDeepStrictEqual(
      steps.map((step) => step.name),
      expectedStepNames,
    )
  ) {
    errors.push(`${jobName} must contain only the reviewed identity-lane steps in order`);
  }
  if (
    checkout &&
    prepare &&
    execute &&
    resourceCleanup &&
    credentialCleanup &&
    upload &&
    !(
      steps.indexOf(checkout) < steps.indexOf(prepare) &&
      steps.indexOf(prepare) < steps.indexOf(execute) &&
      steps.indexOf(execute) < steps.indexOf(resourceCleanup) &&
      steps.indexOf(resourceCleanup) < steps.indexOf(credentialCleanup) &&
      steps.indexOf(credentialCleanup) < steps.indexOf(upload)
    )
  ) {
    errors.push(
      `${jobName} must prepare, execute, verify cleanup, remove credentials, then upload evidence`,
    );
  }

  const trustedDispatch =
    "github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'";
  const privateHome = "${{ runner.temp }}/nemoclaw-brev-launchable-identity-home";
  const prepareEnv = asRecord(prepare?.env);
  if (
    !isDeepStrictEqual(Object.keys(prepareEnv).sort(), [
      "BREV_API_KEY",
      "BREV_CLI_SHA256",
      "BREV_CLI_VERSION",
      "BREV_ORG_ID",
      "HOME",
    ])
  ) {
    errors.push(`${jobName} preparation step must receive only its reviewed environment`);
  }
  for (const [key, secret] of [
    ["BREV_API_KEY", "BREV_API_KEY"],
    ["BREV_ORG_ID", "BREV_ORG_ID"],
  ] as const) {
    const expected = `\${{ ${trustedDispatch} && secrets.${secret} || '' }}`;
    if (prepareEnv[key] !== expected) {
      errors.push(`${jobName} ${key} must use the trusted manual-dispatch guard`);
    }
  }
  if (prepareEnv.HOME !== privateHome) {
    errors.push(`${jobName} must keep Brev credentials in its private runner home`);
  }
  if (
    !/^0\.\d+\.\d+$/u.test(stringValue(prepareEnv.BREV_CLI_VERSION)) ||
    !/^[0-9a-f]{64}$/u.test(stringValue(prepareEnv.BREV_CLI_SHA256))
  ) {
    errors.push(`${jobName} must pin the Brev CLI version and SHA-256 checksum`);
  }
  for (const forbidden of ["GH_TOKEN", "NVIDIA_INFERENCE_API_KEY"]) {
    if (Object.hasOwn(prepareEnv, forbidden)) {
      errors.push(`${jobName} preparation step must not receive ${forbidden}`);
    }
  }
  const prepareRun = stringValue(prepare?.run);
  for (const required of [
    'install -d -m 0700 "$HOME"',
    "sha256sum -c -",
    'brev login --api-key "$BREV_API_KEY" --org-id "$BREV_ORG_ID"',
  ]) {
    if (!prepareRun.includes(required))
      errors.push(`${jobName} preparation must retain ${required}`);
  }

  const executeEnv = asRecord(execute?.env);
  if (
    !isDeepStrictEqual(Object.keys(executeEnv).sort(), [
      "BREV_LAUNCHABLE_ID",
      "GH_TOKEN",
      "HOME",
      "NEMOCLAW_BREV_DEFER_CLEANUP",
      "NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY",
      "WORK_DIR",
    ])
  ) {
    errors.push(`${jobName} execution step must receive only its reviewed environment`);
  }
  if (execute?.run !== "tools/e2e/brev-launchable-e2e.sh" || execute?.["timeout-minutes"] !== 150) {
    errors.push(`${jobName} must execute the trusted shared Launchable harness`);
  }
  if (executeEnv.BREV_LAUNCHABLE_ID !== "${{ vars.NEMOCLAW_STAGING_LAUNCHABLE_ID }}") {
    errors.push(`${jobName} must use the configured staging Launchable`);
  }
  if (
    executeEnv.GH_TOKEN !==
    "${{ github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && secrets.NEMOCLAW_IMAGE_DISPATCH_TOKEN || '' }}"
  ) {
    errors.push(`${jobName} image dispatch token must use the trusted manual-dispatch guard`);
  }
  if (
    executeEnv.HOME !== privateHome ||
    executeEnv.NEMOCLAW_BREV_DEFER_CLEANUP !== "1" ||
    executeEnv.NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY !== "1" ||
    executeEnv.WORK_DIR !== "${{ steps.workspace.outputs.work_dir }}"
  ) {
    errors.push(
      `${jobName} must bind its private home, deferred cleanup, identity mode, and evidence directory`,
    );
  }
  for (const forbidden of [
    "BREV_API_KEY",
    "BREV_ORG_ID",
    "NVIDIA_INFERENCE_API_KEY",
    "NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY",
  ]) {
    if (Object.hasOwn(executeEnv, forbidden)) {
      errors.push(`${jobName} execution step must not receive ${forbidden}`);
    }
  }

  const resourceCleanupEnv = asRecord(resourceCleanup?.env);
  if (
    resourceCleanup?.if !== "${{ always() && steps.workspace.outputs.work_dir != '' }}" ||
    resourceCleanup?.["timeout-minutes"] !== 15 ||
    resourceCleanup?.run !== "tools/e2e/brev-launchable-e2e.sh cleanup-owned-workspace" ||
    !isDeepStrictEqual(resourceCleanupEnv, {
      BREV_CREATE_RECONCILE_SECONDS: "120",
      BREV_DELETE_TIMEOUT_SECONDS: "600",
      HOME: privateHome,
      POLL_SECONDS: "15",
      WORK_DIR: "${{ steps.workspace.outputs.work_dir }}",
    })
  ) {
    errors.push(`${jobName} must reserve and verify exact-name workspace cleanup`);
  }

  for (const currentStep of steps) {
    const currentEnv = asRecord(currentStep.env);
    if (
      Object.hasOwn(currentEnv, "NVIDIA_INFERENCE_API_KEY") ||
      Object.keys(currentEnv).some((key) => /(?:GCP|GOOGLE)_/u.test(key))
    ) {
      errors.push(
        `${jobName} steps must not receive NVIDIA_INFERENCE_API_KEY or GCP_/GOOGLE_ environment identifiers`,
      );
      break;
    }
  }

  const cleanupEnv = asRecord(credentialCleanup?.env);
  if (
    credentialCleanup?.if !== "always()" ||
    !isDeepStrictEqual(cleanupEnv, { HOME: privateHome }) ||
    !stringValue(credentialCleanup?.run).includes("$HOME/.brev/credentials.json") ||
    !stringValue(credentialCleanup?.run).includes('rm -f -- "$credentials"') ||
    !stringValue(credentialCleanup?.run).includes('test ! -e "$credentials"')
  ) {
    errors.push(`${jobName} must always remove and verify removal of its Brev credential file`);
  }
  if (!isDeepStrictEqual(asRecord(upload?.env), {})) {
    errors.push(`${jobName} evidence upload step must not receive environment values`);
  }
}

function validateStagingBrevLaunchableInput(
  errors: string[],
  dispatchInputs: WorkflowRecord,
): void {
  const input = requireInput(errors, dispatchInputs, "include_staging_brev_launchable");
  if (input.type !== "boolean" || input.default !== false) {
    errors.push(
      "workflow_dispatch include_staging_brev_launchable input must be boolean and default to false",
    );
  }
  const description = stringValue(input.description);
  if (
    !description.includes("Exact staging Brev Launchable") ||
    !description.includes("jobs and targets are empty") ||
    !description.includes("full E2E run")
  ) {
    errors.push(
      "workflow_dispatch include_staging_brev_launchable input must document full-run Launchable E2E scope",
    );
  }
}

function validateRetiredSelectorCompatibilityJob(errors: string[], jobs: WorkflowRecord): void {
  const job = asRecord(jobs["retired-selector-compatibility"]);
  if (Object.keys(job).length === 0) {
    errors.push("workflow missing retired-selector-compatibility job");
    return;
  }
  const jobSelectorGate = RETIRED_CONTROLLER_SELECTOR_IDS.map(
    (id) => `contains(format(',{0},', inputs.jobs), ',${id},')`,
  ).join(" || ");
  const targetSelectorGate = RETIRED_CONTROLLER_TARGET_SELECTOR_IDS.map(
    (id) => `contains(format(',{0},', inputs.targets), ',${id},')`,
  ).join(" || ");
  const expectedIf = `\${{ inputs.checkout_sha != '' && (${jobSelectorGate} || ${targetSelectorGate}) }}`;
  if (job.if !== expectedIf) {
    errors.push(
      "retired-selector-compatibility job selector gate must match retired selector contract",
    );
  }

  const steps = asSteps(job.steps);
  const checkout = steps.find((step) => stringValue(step.uses).startsWith("actions/checkout@"));
  if (!checkout) {
    errors.push("retired-selector-compatibility job must check out the candidate revision");
  } else {
    requireFullShaAction(errors, checkout, "retired-selector-compatibility checkout");
    const checkoutWith = asRecord(checkout.with);
    if (
      checkoutWith.repository !== "${{ inputs.checkout_repository || github.repository }}" ||
      checkoutWith.ref !== "${{ inputs.checkout_sha || github.sha }}" ||
      checkoutWith["persist-credentials"] !== false
    ) {
      errors.push("retired-selector-compatibility job must check out the candidate revision");
    }
  }

  const verify = namedStep(steps, "Verify retired selector replacements");
  if (
    stringValue(verify?.run) !== "npx tsx tools/e2e/retired-selector-compatibility.mts" ||
    asRecord(verify?.env).JOBS !== "${{ inputs.jobs }}"
  ) {
    errors.push("retired-selector-compatibility job must invoke the replacement helper");
  }
  if (asRecord(verify?.env).TARGETS !== "${{ inputs.targets }}") {
    errors.push("retired-selector-compatibility job must forward target selectors");
  }

  const upload = namedStep(steps, "Upload retired selector compatibility evidence");
  if (
    upload?.if !== "always()" ||
    upload?.uses !== UPLOAD_E2E_ARTIFACTS_ACTION ||
    !isDeepStrictEqual(asRecord(upload?.with), {
      name: "e2e-retired-selector-compatibility",
      path: "e2e-artifacts/live/retired-selector-compatibility/",
    })
  ) {
    errors.push("retired-selector-compatibility job must upload compatibility evidence");
  }
}

function validateTrustedE2eDispatchReceipt(
  errors: string[],
  generateSteps: readonly WorkflowStep[],
): void {
  const dispatchReceipt = requireStep(errors, generateSteps, "Record trusted E2E dispatch receipt");
  if (dispatchReceipt?.if !== "${{ github.event_name == 'workflow_dispatch' }}") {
    errors.push("trusted E2E dispatch receipt must run for workflow dispatches only");
  }
  const dispatchReceiptEnv = asRecord(dispatchReceipt?.env);
  const expectedDispatchReceiptEnv = {
    ACTOR: "${{ github.actor }}",
    ALLOW_DGX_SPARK_RUNNER_QUEUE: "${{ inputs.allow_dgx_spark_runner_queue && 'true' || 'false' }}",
    ALLOW_JETSON_DISPATCH: "${{ inputs.allow_jetson_dispatch && 'true' || 'false' }}",
    ALLOW_JETSON_RUNNER_QUEUE: "false",
    BASE_SHA: "${{ inputs.checkout_sha != '' && inputs.base_sha || github.sha }}",
    CANDIDATE_REPOSITORY: "${{ inputs.checkout_repository || github.repository }}",
    CANDIDATE_SHA: "${{ inputs.checkout_sha || github.sha }}",
    DISPATCH_JOBS: "${{ inputs.jobs }}",
    DISPATCH_RECEIPT_DIR: "${{ runner.temp }}/nemoclaw-e2e-dispatch",
    DISPATCH_TARGETS: "${{ inputs.targets }}",
    EVENT_NAME: "${{ github.event_name }}",
    INCLUDE_STAGING_BREV_LAUNCHABLE:
      "${{ inputs.include_staging_brev_launchable && 'true' || 'false' }}",
    PR_NUMBER: "${{ inputs.checkout_sha != '' && inputs.pr_number || '' }}",
    REPOSITORY: "${{ github.repository }}",
    RUN_ATTEMPT: "${{ github.run_attempt }}",
    RUN_ID: "${{ github.run_id }}",
    TRIGGERING_ACTOR: "${{ github.triggering_actor }}",
    WORKFLOW_SHA: "${{ github.workflow_sha }}",
  };
  if (!isDeepStrictEqual(dispatchReceiptEnv, expectedDispatchReceiptEnv)) {
    errors.push(
      "trusted E2E dispatch receipt must bind only the authenticated repository, PR, candidate, workflow, run, and dispatch identities",
    );
  }
  if (dispatchReceipt?.shell !== "bash") {
    errors.push("trusted E2E dispatch receipt must use bash");
  }
  for (const fragment of [
    'kind: "nemoclaw-e2e-dispatch-v2"',
    "actor: $actor",
    "repository: $repository",
    'prNumber: (if $prNumber == "" then null else ($prNumber | tonumber) end)',
    "candidateRepository: $candidateRepository",
    "candidateSha: $candidateSha",
    "baseSha: $baseSha",
    "workflowSha: $workflowSha",
    "eventName: $eventName",
    "workflowRunId: $workflowRunId",
    "workflowRunAttempt: $workflowRunAttempt",
    "jobs: $jobs",
    "targets: $targets",
    "allowDgxSparkRunnerQueue: $allowDgxSparkRunnerQueue",
    "allowJetsonDispatch: $allowJetsonDispatch",
    "allowJetsonRunnerQueue: $allowJetsonRunnerQueue",
    "includeStagingBrevLaunchable: $includeStagingBrevLaunchable",
    "triggeringActor: $triggeringActor",
    'emptySelectors: ($jobs == "" and $targets == "")',
    '>"$DISPATCH_RECEIPT_DIR/dispatch.json"',
  ]) {
    requireRunContains(errors, dispatchReceipt, fragment);
  }

  const dispatchUpload = requireStep(errors, generateSteps, "Upload trusted E2E dispatch receipt");
  if (dispatchUpload?.if !== "${{ github.event_name == 'workflow_dispatch' }}") {
    errors.push("trusted E2E dispatch receipt upload must run for workflow dispatches only");
  }
  if (dispatchUpload?.uses !== UPLOAD_E2E_ARTIFACTS_ACTION) {
    errors.push("trusted E2E dispatch receipt upload must use the reviewed pinned action");
  }
  if (
    !isDeepStrictEqual(asRecord(dispatchUpload?.with), {
      name: "e2e-dispatch-${{ github.run_id }}-${{ github.run_attempt }}",
      path: "${{ runner.temp }}/nemoclaw-e2e-dispatch/dispatch.json",
    })
  ) {
    errors.push("trusted E2E dispatch receipt upload must preserve its immutable run identity");
  }

  const authentication = namedStep(generateSteps, "Authenticate manual PR dispatch");
  const candidateCheckout = namedStep(generateSteps, "Check out E2E candidate");
  const authenticationIndex = authentication ? generateSteps.indexOf(authentication) : -1;
  const receiptIndex = dispatchReceipt ? generateSteps.indexOf(dispatchReceipt) : -1;
  const uploadIndex = dispatchUpload ? generateSteps.indexOf(dispatchUpload) : -1;
  const checkoutIndex = candidateCheckout ? generateSteps.indexOf(candidateCheckout) : -1;
  const trustedPrefix = [
    "Build trusted larger-runner routing",
    "Authenticate manual PR dispatch",
    "Build trusted controller target matrix",
    "Record trusted E2E dispatch receipt",
    "Upload trusted E2E dispatch receipt",
  ];
  if (
    !isDeepStrictEqual(
      generateSteps.slice(0, trustedPrefix.length).map((step) => step.name),
      trustedPrefix,
    ) ||
    authenticationIndex < 0 ||
    receiptIndex !== authenticationIndex + 2 ||
    uploadIndex !== receiptIndex + 1 ||
    checkoutIndex <= uploadIndex
  ) {
    errors.push(
      "trusted E2E dispatch receipt must be created and uploaded immediately after authentication and before candidate execution",
    );
  }
}

function validateTrustedE2ePlannerBoundary(
  errors: string[],
  generateSteps: WorkflowRecord[],
  generate: WorkflowRecord | undefined,
  candidateCheckout: WorkflowRecord | undefined,
): void {
  const trustedPlannerCheckout = requireStep(
    errors,
    generateSteps,
    "Check out trusted E2E planner",
  );
  const trustedPlannerSetup = requireStep(
    errors,
    generateSteps,
    "Set up Node for trusted E2E planning",
  );
  const trustedPlannerInstall = requireStep(
    errors,
    generateSteps,
    "Install trusted E2E planner dependencies",
  );
  requireFullShaAction(errors, trustedPlannerCheckout, "trusted E2E planner checkout");
  if (
    !isDeepStrictEqual(asRecord(trustedPlannerCheckout?.with), {
      repository: "${{ github.repository }}",
      ref: "${{ github.workflow_sha }}",
      "fetch-depth": 0,
      "persist-credentials": false,
    })
  ) {
    errors.push("trusted E2E planner checkout must use the workflow commit without credentials");
  }
  requireFullShaAction(errors, trustedPlannerSetup, "trusted E2E planner Node setup");
  if (
    !isDeepStrictEqual(asRecord(trustedPlannerSetup?.with), {
      "node-version": 22,
    })
  ) {
    errors.push("trusted E2E planner must use Node 22");
  }
  if (trustedPlannerInstall?.run !== "npm ci --ignore-scripts --no-audit --no-fund") {
    errors.push("trusted E2E planner dependencies must install without lifecycle scripts");
  }
  const trustedPlannerIndex = trustedPlannerCheckout
    ? generateSteps.indexOf(trustedPlannerCheckout)
    : -1;
  const trustedSetupIndex = trustedPlannerSetup ? generateSteps.indexOf(trustedPlannerSetup) : -1;
  const trustedInstallIndex = trustedPlannerInstall
    ? generateSteps.indexOf(trustedPlannerInstall)
    : -1;
  const generateIndex = generate ? generateSteps.indexOf(generate) : -1;
  const candidateCheckoutIndex = candidateCheckout ? generateSteps.indexOf(candidateCheckout) : -1;
  if (
    trustedPlannerIndex < 0 ||
    trustedSetupIndex <= trustedPlannerIndex ||
    trustedInstallIndex <= trustedSetupIndex ||
    generateIndex <= trustedInstallIndex ||
    candidateCheckoutIndex <= generateIndex
  ) {
    errors.push("trusted E2E planning must finish before candidate checkout and execution");
  }

  const generateEnv = asRecord(generate?.env);
  if (
    generateEnv.NEMOCLAW_E2E_CREDENTIALS_ALLOWED !==
    "${{ (inputs.checkout_sha == '' || steps.candidate_authorization.outputs.nvidia_owned == 'true') && 'true' || 'false' }}"
  ) {
    errors.push("matrix generation step must bind NVIDIA-owned candidate authorization");
  }
  if (generateEnv.NVIDIA_OWNED !== "${{ steps.candidate_authorization.outputs.nvidia_owned }}") {
    errors.push("matrix generation step must bind the authenticated PR repository owner");
  }
}

export function validateE2eWorkflow(workflowValue: unknown): string[] {
  const workflow = asRecord(workflowValue);
  const errors: string[] = [];
  errors.push(...validateE2eWorkspaceBootstrapBoundary(workflow));
  errors.push(...validateUploadE2eArtifactsWorkflowBoundary(workflow));
  errors.push(...validateHermesDashboardWorkflow(workflow as unknown as HermesDashboardWorkflow));
  errors.push(...validateHermesGpuStartupWorkflow(workflow));
  errors.push(...validateLlamaCppDgxSparkQualificationWorkflow(workflow));
  errors.push(...validateManagedImageMultiarchWorkflow(workflow));
  errors.push(...validateManagedImageProtectedRuntimeWorkflow(workflow));
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
  errors.push(...validateE2eOperationsWorkflow(workflow as unknown as OperationsWorkflow));
  errors.push(...validateStandardProfileWorkflowBoundary(workflow));
  errors.push(...validateTrustedHermesSwapWorkflow(workflow));
  errors.push(...validateRunnerComparisonWorkflowBoundary(workflow));
  const triggers = asRecord(workflow.on ?? workflow[true as unknown as string]);

  const workflowDispatch = requireWorkflowDispatch(errors, triggers);
  requirePushRun(errors, triggers);
  rejectUnexpectedTriggers(errors, triggers);

  const dispatchInputs = asRecord(workflowDispatch.inputs);
  requireInput(errors, dispatchInputs, "targets");
  validateFullE2eConcurrency(errors, workflow);
  validateStagingBrevLaunchableInput(errors, dispatchInputs);
  validateInferenceModeInput(errors, workflow, dispatchInputs);
  const jobsInput = requireInput(errors, dispatchInputs, "jobs");
  const jobsDescription = stringValue(jobsInput.description);
  if (!jobsDescription.includes("include_staging_brev_launchable")) {
    errors.push(
      "workflow_dispatch jobs input description must identify how to include Exact staging Brev Launchable",
    );
  }
  if (!jobsDescription.includes("staging-brev-launchable-identity")) {
    errors.push(
      "workflow_dispatch jobs input must document the explicit Launchable identity smoke selector",
    );
  }
  if (Object.hasOwn(dispatchInputs, "test_filter")) {
    errors.push("workflow_dispatch must not expose legacy test_filter input");
  }

  const permissions = asRecord(workflow.permissions);
  if (permissions.contents !== "read") errors.push("workflow permissions.contents must be read");

  const jobs = asRecord(workflow.jobs);
  if (Object.hasOwn(jobs, "staging-brev-launchable-readiness")) {
    errors.push("workflow must not define superseded staging-brev-launchable-readiness job");
  }
  if (Object.hasOwn(jobs, "openshell-gateway-upgrade")) {
    errors.push("workflow must not define superseded openshell-gateway-upgrade job");
  }
  validateRetiredSelectorCompatibilityJob(errors, jobs);
  const expectedRunName =
    "${{ inputs.checkout_sha != '' && format('E2E PR #{0} ({1})', inputs.pr_number, inputs.correlation_id) || inputs.correlation_id != '' && inputs.include_staging_brev_launchable && inputs.jobs == '' && inputs.targets == '' && !inputs.allow_jetson_dispatch && !inputs.allow_dgx_spark_runner_queue && format('E2E full {0} ({1})', github.ref_name, inputs.correlation_id) || inputs.include_staging_brev_launchable && inputs.jobs == '' && inputs.targets == '' && !inputs.allow_jetson_dispatch && !inputs.allow_dgx_spark_runner_queue && format('E2E full {0}', github.ref_name) || inputs.correlation_id != '' && format('E2E {0} ({1})', github.ref_name, inputs.correlation_id) || format('E2E {0}', github.ref_name) }}";
  if (workflow["run-name"] !== expectedRunName) {
    errors.push("workflow run-name must expose the unique manual-dispatch correlation ID");
  }
  errors.push(...validateJetsonDispatchBoundary(workflow));
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
  if (generateMatrix["timeout-minutes"] !== 10) {
    errors.push("generate-matrix job must keep the 10 minute timeout");
  }
  const generateOutputs = asRecord(generateMatrix.outputs);
  if (generateOutputs.matrix !== "${{ steps.matrix.outputs.matrix }}") {
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
  if (
    generateOutputs.release_required_jobs !== "${{ steps.matrix.outputs.release_required_jobs }}"
  ) {
    errors.push("generate-matrix job must expose release_required_jobs output");
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
  if (
    controllerMatrix?.if !==
    "${{ inputs.checkout_sha != '' && steps.candidate_authorization.outputs.nvidia_owned != 'true' }}"
  ) {
    errors.push("trusted controller matrix step must run only for external PR dispatches");
  }
  if (controllerMatrix?.shell !== "bash") {
    errors.push("trusted controller matrix step must use bash");
  }
  const controllerMatrixEnv = asRecord(controllerMatrix?.env);
  if (controllerMatrixEnv.JOBS !== "${{ inputs.jobs }}") {
    errors.push("trusted controller matrix step must bind jobs through JOBS env");
  }
  if (controllerMatrixEnv.TARGETS !== "${{ inputs.targets }}") {
    errors.push("trusted controller matrix step must bind targets through TARGETS env");
  }
  requireRunContains(errors, controllerMatrix, 'case "${JOBS}:${TARGETS}" in');
  const controllerMatrixScript = stringValue(controllerMatrix?.run);
  const policyTarget = "ubuntu-policy-custom-missing-presets-negative";
  const deepAgentsTarget = "ubuntu-repo-cloud-langchain-deepagents-code";
  const openClawTarget = "ubuntu-repo-cloud-openclaw";
  const postRebootTarget = "ubuntu-repo-docker-post-reboot-recovery";
  const defaultMappings = [policyTarget, deepAgentsTarget, openClawTarget, postRebootTarget]
    .map((target) => `{"id":"${target}","runner":"ubuntu-latest"}`)
    .join(",");
  const deepAgentsMapping = `{"id":"${deepAgentsTarget}","runner":"ubuntu-latest","label":"${deepAgentsTarget}"}`;
  const postRebootMapping = `{"id":"${postRebootTarget}","runner":"ubuntu-latest","label":"${postRebootTarget}"}`;
  const defaultTestMappings = [
    {
      file: "test/onboard-managed-image-buildless-e2e.test.ts",
      id: "onboard-managed-image-buildless-e2e",
      project: "integration",
    },
    {
      file: "test/vllm-docker-storage.test.ts",
      id: "vllm-docker-storage",
      project: "integration",
    },
  ]
    .map(({ file, id, project }) => `{"id":"${id}","file":"${file}","project":"${project}"}`)
    .join(",");
  requireRunContains(errors, controllerMatrix, `matrix='[${defaultMappings}]'`);
  requireRunContains(errors, controllerMatrix, `test_matrix='[${defaultTestMappings}]'`);
  const trustedControllerMatrixScript = [
    "set -euo pipefail",
    "test_matrix='[]'",
    'case "${JOBS}:${TARGETS}" in',
    ":)",
    `matrix='[${defaultMappings}]'`,
    `test_matrix='[${defaultTestMappings}]'`,
    ";;",
    "inference-routing: | managed-image-protected-runtime: | native-runtime-qualification-producer: | :jetson-nvmap-gpu)",
    "matrix='[]'",
    ";;",
    `:${deepAgentsTarget})`,
    `matrix='[${deepAgentsMapping}]'`,
    ";;",
    `:${postRebootTarget})`,
    `matrix='[${postRebootMapping}]'`,
    ";;",
    `:${deepAgentsTarget},${postRebootTarget})`,
    `matrix='[${deepAgentsMapping},${postRebootMapping}]'`,
    ";;",
    "*)",
    'echo "::error::PR E2E target is not approved by the trusted controller" >&2',
    "exit 1",
    ";;",
    "esac",
    `printf 'matrix=%s\\n' "\${matrix}" >> "\${GITHUB_OUTPUT}"`,
    `printf 'test_matrix=%s\\n' "\${test_matrix}" >> "\${GITHUB_OUTPUT}"`,
  ];
  const controllerMatrixLines = controllerMatrixScript
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!isDeepStrictEqual(controllerMatrixLines, trustedControllerMatrixScript)) {
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
  const generateCheckout = requireStep(errors, generateSteps, "Check out E2E candidate");
  if (!generateCheckout) errors.push("generate-matrix job missing checkout step");
  const candidateAuthorization = generateSteps.find(
    (step) => stringValue(step.id) === "candidate_authorization",
  );
  if (
    controllerMatrix &&
    candidateAuthorization &&
    generateSteps.indexOf(controllerMatrix) <= generateSteps.indexOf(candidateAuthorization)
  ) {
    errors.push("external controller matrix must run after PR ownership authentication");
  }
  if (
    controllerMatrix &&
    generateCheckout &&
    generateSteps.indexOf(controllerMatrix) >= generateSteps.indexOf(generateCheckout)
  ) {
    errors.push("external controller matrix must run before PR checkout");
  }
  requireFullShaAction(errors, generateCheckout, "generate-matrix checkout");
  if (asRecord(generateCheckout?.with)["persist-credentials"] !== false) {
    errors.push("generate-matrix checkout step must set persist-credentials=false");
  }
  validateLargerRunnerRouting(errors, jobs, generateMatrix, generateSteps, generateCheckout);
  const generate = requireStep(errors, generateSteps, "Generate E2E target matrix");
  validateTrustedE2ePlannerBoundary(errors, generateSteps, generate, generateCheckout);
  const generateEnv = asRecord(generate?.env);
  if (generateEnv.CHECKOUT_SHA !== "${{ inputs.checkout_sha }}") {
    errors.push("matrix generation step must bind controller checkout through CHECKOUT_SHA env");
  }
  if (generateEnv.CONTROLLER_MATRIX !== "${{ steps.controller_matrix.outputs.matrix }}") {
    errors.push("matrix generation step must receive the trusted controller matrix");
  }
  if (generateEnv.CONTROLLER_TEST_MATRIX !== "${{ steps.controller_matrix.outputs.test_matrix }}") {
    errors.push("matrix generation step must receive the trusted controller test matrix");
  }
  if (generateEnv.JOBS !== "${{ inputs.jobs }}") {
    errors.push("matrix generation step must pass jobs through JOBS env");
  }
  if (generateEnv.TARGETS !== "${{ inputs.targets }}") {
    errors.push("matrix generation step must pass targets through TARGETS env");
  }
  validateInferenceModeGeneration(errors, generate, generateEnv);
  requireRunContains(errors, generate, "npx --no-install tsx tools/e2e/workflow-plan.mts");
  requireRunContains(errors, generate, "--ci-output");
  requireRunContains(errors, generate, "git diff --name-only --diff-filter=ACMRD");
  requireRunContains(
    errors,
    generate,
    'if [ -n "${CHECKOUT_SHA}" ] && [ "${NVIDIA_OWNED}" != "true" ]',
  );
  requireRunContains(errors, generate, "GITHUB_OUTPUT");
  requireRunContains(errors, generate, "expected_controller_matrix=");
  requireRunContains(errors, generate, "actual_controller_matrix=");
  requireRunContains(errors, generate, "expected_controller_test_matrix=");
  requireRunContains(errors, generate, "actual_controller_test_matrix=");
  requireRunContains(errors, generate, ': > "${GITHUB_OUTPUT}"');
  requireRunContains(
    errors,
    generate,
    "E2E planner matrix does not match controller-selected targets",
  );
  validateTrustedE2eDispatchReceipt(errors, generateSteps);

  const liveTargets = asRecord(jobs["live"]);
  if (Object.keys(liveTargets).length === 0) errors.push("workflow missing live job");
  if (liveTargets.name !== "${{ matrix.label }}") {
    errors.push("live job name must expose the semantic matrix label");
  }
  if (liveTargets["runs-on"] !== "${{ matrix.runner }}") {
    errors.push("live job must run on the matrix runner");
  }
  if (liveTargets["timeout-minutes"] !== "${{ matrix.timeout_minutes }}") {
    errors.push("live job timeout must come from the typed target matrix");
  }
  if (!isDeepStrictEqual(liveTargets.needs, ["base-image-publication", "generate-matrix"])) {
    errors.push("live job must depend on base-image-publication and generate-matrix");
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
  requireRunContains(errors, runVitest, '"^${TARGET_ID}:"');

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
    "e2e-artifacts/live/${{ matrix.id }}/test-progress.json",
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
  validateStagingBrevLaunchableJob(errors, jobs);
  validateStagingBrevLaunchableIdentityJob(errors, jobs);
  validateCatalogueOwnedJobs(errors, jobs);
  validateHermesE2EJob(errors, jobs);
  validateHermesTimeoutHeadroom(errors, jobs);

  const reportToPr = asRecord(jobs["report-to-pr"]);
  if (Object.keys(reportToPr).length === 0) {
    errors.push("workflow missing report-to-pr job");
  } else {
    if (reportToPr["timeout-minutes"] !== 15) {
      errors.push("report-to-pr job must keep the 15 minute timeout");
    }
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
      errors.push(
        "report-to-pr must derive jobs omitted from the manual run from workflow inventory",
      );
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
      if (
        !stringValue(checkoutWith["sparse-checkout"]).includes("tools/e2e/selector-aliases.mts")
      ) {
        errors.push("report-to-pr report helper checkout must sparse-checkout selector aliases");
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

  const scorecard = asRecord(jobs.scorecard);
  if (scorecard["timeout-minutes"] !== 15) {
    errors.push("scorecard job must keep the 15 minute timeout");
  }

  return errors;
}

export function validateE2eWorkflowBoundary(workflowPath = DEFAULT_E2E_WORKFLOW_PATH): string[] {
  const workflow = readWorkflowRecord(workflowPath);
  return [
    ...validateDockerHubAuthAction(),
    ...validateDockerHubCleanupAction(),
    ...validateHostDependencyAction(),
    ...validateE2eWorkflow(workflow),
    ...validateTrustedHermesSwapHelperSource(
      readFileSync(DEFAULT_LIVE_VITEST_INVOCATION_PATH, "utf8"),
    ),
  ];
}
