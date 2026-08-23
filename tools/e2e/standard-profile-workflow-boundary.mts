// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";
import { E2E_EXECUTION_PROFILES } from "./target-catalogue.mts";
import { TRUSTED_HERMES_SWAP_SCRIPT } from "./trusted-hermes-swap-workflow-boundary.mts";
import { E2E_ACTION_PROVENANCE } from "./workflow-boundary-policy.mts";

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  env?: WorkflowRecord;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: WorkflowRecord;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_PROFILE_PATH = join(REPO_ROOT, ".github", "workflows", "e2e-standard-profile.yaml");
const PROFILE_WORKFLOW = "./.github/workflows/e2e-standard-profile.yaml";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const EXECUTION_PLAN_SHELL = "/bin/bash --noprofile --norc -e -o pipefail {0}";
const TRUSTED_CALLER_CREDENTIAL_PREDICATE =
  "github.repository == 'NVIDIA/NemoClaw' && (github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == 'refs/heads/main')) && (inputs.checkout_sha == '' || needs.generate-matrix.outputs.e2e_credentials_allowed == 'true')";
const guardedCallerSecret = (name: string): string =>
  `\${{ ${TRUSTED_CALLER_CREDENTIAL_PREDICATE} && secrets.${name} || '' }}`;
const SKILL_AGENT_UPLOAD_PATH = `${[
  "e2e-artifacts/live/skill-agent/evidence-manifest.json",
  "e2e-artifacts/live/skill-agent/*/artifact-summary.json",
  "e2e-artifacts/live/skill-agent/*/cleanup.json",
  "e2e-artifacts/live/skill-agent/*/cleanup-skill-agent-summary.json",
  "e2e-artifacts/live/skill-agent/*/target.json",
  "e2e-artifacts/live/skill-agent/*/target-result.json",
  "e2e-artifacts/live/skill-agent/*/test-progress.json",
  "e2e-artifacts/live/skill-agent/*/shell/*.result.json",
  "e2e-artifacts/live/skill-agent/*/shell/*.stdout.txt",
  "e2e-artifacts/live/skill-agent/*/shell/*.stderr.txt",
].join("\n")}\n`;
const PROFILE_JOBS = {
  standard: {
    job: "catalogue-standard",
    matrix: "catalogue_standard_matrix",
    credentialBoundary: "no provider credential",
    secrets: ["DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME"],
    githubToken: false,
    maxParallel: undefined,
  },
  "nvidia-api": {
    job: "catalogue-nvidia-api",
    matrix: "catalogue_nvidia_api_matrix",
    credentialBoundary: "NVIDIA API key",
    secrets: ["DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME", "NVIDIA_API_KEY"],
    githubToken: false,
    maxParallel: undefined,
  },
  "nvidia-inference": {
    job: "catalogue-nvidia-inference",
    matrix: "catalogue_nvidia_inference_matrix",
    credentialBoundary: "NVIDIA inference API key",
    secrets: ["DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME", "NVIDIA_INFERENCE_API_KEY"],
    githubToken: false,
    maxParallel: undefined,
  },
  "github-read": {
    job: "catalogue-github-read",
    matrix: "catalogue_github_read_matrix",
    credentialBoundary: "GitHub read token",
    secrets: ["DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME"],
    githubToken: true,
    maxParallel: undefined,
  },
  "brave-nvidia-inference": {
    job: "catalogue-brave-nvidia-inference",
    matrix: "catalogue_brave_nvidia_inference_matrix",
    credentialBoundary: "Brave and NVIDIA inference API keys",
    secrets: [
      "BRAVE_API_KEY",
      "DOCKERHUB_TOKEN",
      "DOCKERHUB_USERNAME",
      "NVIDIA_INFERENCE_API_KEY",
    ],
    githubToken: false,
    maxParallel: 2,
  },
} as const;

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function steps(value: unknown): WorkflowStep[] {
  return Array.isArray(value) ? (value as WorkflowStep[]) : [];
}

function namedStep(workflowSteps: readonly WorkflowStep[], name: string): WorkflowStep | undefined {
  return workflowSteps.find((step) => step.name === name);
}

function requireStep(
  errors: string[],
  workflowSteps: readonly WorkflowStep[],
  name: string,
): WorkflowStep | undefined {
  const matches = workflowSteps.filter((step) => step.name === name);
  if (matches.length !== 1) errors.push(`standard E2E profile must define one '${name}' step`);
  return matches[0];
}

function requirePinnedAction(errors: string[], step: WorkflowStep | undefined, name: string): void {
  if (!step?.uses || !/@[0-9a-f]{40}$/u.test(step.uses)) {
    errors.push(`standard E2E profile ${name} action must use a full commit SHA`);
  }
}

function validateProfileCallers(errors: string[], workflow: WorkflowRecord): void {
  const jobs = record(workflow.jobs);
  for (const profile of E2E_EXECUTION_PROFILES) {
    const contract = PROFILE_JOBS[profile];
    const job = record(jobs[contract.job]);
    if (Object.keys(job).length === 0) {
      errors.push(`workflow is missing ${contract.job}`);
      continue;
    }
    if (job.needs !== "generate-matrix" || job.uses !== PROFILE_WORKFLOW) {
      errors.push(`${contract.job} must call the standard E2E profile after matrix generation`);
    }
    if (job.name !== "${{ matrix.display_name }}") {
      errors.push(`${contract.job} must use the planned outcome-first display name`);
    }
    const matrixOutput = `needs.generate-matrix.outputs.${contract.matrix}`;
    if (
      job.if !== `\${{ ${matrixOutput} != '[]' }}` ||
      record(record(job.strategy).matrix).include !== `\${{ fromJSON(${matrixOutput}) }}`
    ) {
      errors.push(`${contract.job} must use its generated catalogue matrix`);
    }
    const withInputs = record(job.with);
    if (record(job.strategy)["max-parallel"] !== contract.maxParallel) {
      errors.push(
        contract.maxParallel === undefined
          ? `${contract.job} must not cap matrix concurrency`
          : `${contract.job} must cap matrix concurrency at ${contract.maxParallel}`,
      );
    }
    for (const [name, expected] of Object.entries({
      candidate_repository: "${{ inputs.checkout_repository || github.repository }}",
      candidate_sha: "${{ inputs.checkout_sha || github.sha }}",
      risk_signal_expected_sha:
        "${{ github.event_name == 'workflow_dispatch' && inputs.checkout_sha != '' && inputs.checkout_sha || '' }}",
      risk_signal_correlation_id:
        "${{ github.event_name == 'workflow_dispatch' && inputs.checkout_sha != '' && inputs.correlation_id || '' }}",
      cli_artifact_provenance: "${{ needs.generate-matrix.outputs.cli_artifact_provenance }}",
      managed_image_catalog: "${{ needs.generate-matrix.outputs.managed_image_catalog }}",
      credential_boundary: contract.credentialBoundary,
      catalogue_id: "${{ matrix.id }}",
      target_id: "${{ matrix.target_id }}",
      runner:
        "${{ matrix.runner_key != '' && fromJSON(needs.generate-matrix.outputs.runner_routing)[matrix.runner_key] || matrix.runner }}",
      checkout_sha: "${{ inputs.checkout_sha }}",
      workflow_sha: "${{ inputs.workflow_sha }}",
      test_file: "${{ matrix.test_file }}",
      timeout_minutes: "${{ matrix.timeout_minutes }}",
      install_mode: "${{ matrix.install_mode }}",
      install_non_interactive: "${{ matrix.install_non_interactive }}",
      restore_cli: "${{ matrix.restore_cli }}",
      cloudflared: "${{ matrix.cloudflared }}",
      host_packages: "${{ matrix.host_packages }}",
      host_preparation: "${{ matrix.host_preparation }}",
      runner_comparison: "${{ matrix.runner_comparison }}",
      compatible_api_key: "${{ matrix.compatible_api_key }}",
      github_token: contract.githubToken,
      shard: "${{ matrix.shard }}",
      artifact_layout: "${{ matrix.artifact_layout }}",
      trusted_main:
        "${{ github.repository == 'NVIDIA/NemoClaw' && (github.event_name == 'workflow_dispatch' || github.ref == 'refs/heads/main') && (inputs.checkout_sha == '' || needs.generate-matrix.outputs.e2e_credentials_allowed == 'true') }}",
    })) {
      if (withInputs[name] !== expected) {
        errors.push(`${contract.job} must pass ${name} from the catalogue matrix`);
      }
    }
    const callerSecrets = record(job.secrets);
    if (
      Object.keys(callerSecrets).sort().join(",") !== [...contract.secrets].sort().join(",") ||
      contract.secrets.some((name) => callerSecrets[name] !== guardedCallerSecret(name))
    ) {
      errors.push(`${contract.job} must receive only its profile secrets`);
    }
  }
}

function validateProfileWorkflow(errors: string[], profile: WorkflowRecord): void {
  const triggers = record(profile.on ?? profile[true as unknown as string]);
  const call = record(triggers.workflow_call);
  const inputs = record(call.inputs);
  const requiredInputs = {
    candidate_repository: "string",
    candidate_sha: "string",
    risk_signal_expected_sha: "string",
    risk_signal_correlation_id: "string",
    cli_artifact_provenance: "string",
    managed_image_catalog: "string",
    credential_boundary: "string",
    catalogue_id: "string",
    target_id: "string",
    runner: "string",
    checkout_sha: "string",
    workflow_sha: "string",
    test_file: "string",
    timeout_minutes: "number",
    install_mode: "string",
    install_non_interactive: "boolean",
    restore_cli: "boolean",
    cloudflared: "boolean",
    host_packages: "string",
    host_preparation: "string",
    runner_comparison: "boolean",
    compatible_api_key: "boolean",
    github_token: "boolean",
    shard: "string",
    artifact_layout: "string",
    trusted_main: "boolean",
  };
  if (
    Object.keys(inputs).sort().join(",") !== Object.keys(requiredInputs).sort().join(",") ||
    Object.entries(requiredInputs).some(
      ([name, type]) =>
        record(inputs[name]).required !== true || record(inputs[name]).type !== type,
    )
  ) {
    errors.push("standard E2E profile must require its exact execution-plan inputs");
  }
  const acceptedSecrets = [
    "DOCKERHUB_TOKEN",
    "DOCKERHUB_USERNAME",
    "NVIDIA_API_KEY",
    "NVIDIA_INFERENCE_API_KEY",
    "BRAVE_API_KEY",
  ];
  const declaredSecrets = record(call.secrets);
  if (
    Object.keys(declaredSecrets).sort().join(",") !== acceptedSecrets.sort().join(",") ||
    acceptedSecrets.some((name) => record(declaredSecrets[name]).required !== false)
  ) {
    errors.push("standard E2E profile must accept only its five optional profile secrets");
  }
  if (record(profile.permissions).contents !== "read") {
    errors.push("standard E2E profile permissions must be contents: read");
  }

  const runJob = record(record(profile.jobs).run);
  if (
    Object.keys(runJob).sort().join(",") !==
    ["env", "name", "runs-on", "steps", "timeout-minutes"].sort().join(",")
  ) {
    errors.push("standard E2E profile must expose only its reviewed job settings");
  }
  if (runJob["runs-on"] !== "${{ inputs.runner }}") {
    errors.push("standard E2E profile must use the catalogue runner");
  }
  if (runJob.name !== "${{ inputs.credential_boundary }}") {
    errors.push("standard E2E profile must show the planned credential boundary");
  }
  if (runJob["timeout-minutes"] !== "${{ inputs.timeout_minutes }}") {
    errors.push("standard E2E profile must use the catalogue timeout");
  }
  const jobEnv = record(runJob.env);
  const expectedJobEnv = {
    E2E_JOB: "1",
    E2E_TARGET_ID: "${{ inputs.target_id }}",
    NEMOCLAW_RUN_LIVE_E2E: "1",
    NEMOCLAW_E2E_EXPECTED_SHA: "${{ inputs.candidate_sha }}",
    NEMOCLAW_E2E_CORRELATION_ID: "${{ inputs.risk_signal_correlation_id }}",
    NEMOCLAW_E2E_RISK_SIGNAL_EXPECTED_SHA: "${{ inputs.risk_signal_expected_sha }}",
    NEMOCLAW_LLAMA_CPP_QUALIFICATION_HEAD_SHA: "${{ inputs.candidate_sha }}",
  };
  if (Object.keys(jobEnv).sort().join(",") !== Object.keys(expectedJobEnv).sort().join(",")) {
    errors.push("standard E2E profile must expose only its reviewed job environment");
  }
  for (const [name, expected] of Object.entries(expectedJobEnv)) {
    if (jobEnv[name] !== expected) errors.push(`standard E2E profile must set ${name}`);
  }

  const workflowSteps = steps(runJob.steps);
  const expectedStepNames = [
    "Validate catalogue execution plan",
    "Provision trusted Hermes E2E swap",
    undefined,
    "Authenticate to Docker Hub",
    "Install target host dependencies",
    "Prepare E2E workspace",
    "Restore exact-commit CLI artifact",
    "Materialize temporary managed-image catalog",
    "Install reviewed cloudflared",
    "Add swap for Hermes image rebuild",
    "Initialize runner comparison telemetry",
    "Install OpenShell CLI",
    "Install OpenShell CLI without workflow credentials",
    "Run catalogue E2E target",
    "Finalize runner comparison telemetry",
    "Write E2E evidence manifest",
    "Upload skill-agent artifacts",
    "Upload E2E artifacts",
    "Clean up Docker auth",
  ];
  if (
    workflowSteps.length !== expectedStepNames.length ||
    workflowSteps.some((step, index) => step.name !== expectedStepNames[index])
  ) {
    errors.push("standard E2E profile must keep its reviewed step set and order");
  }
  const executionPlan = requireStep(errors, workflowSteps, "Validate catalogue execution plan");
  const executionPlanRun = String(executionPlan?.run ?? "");
  const executionPlanFragments = [
    '[[ "$CATALOGUE_ID" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]',
    '[[ "$TARGET_ID" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]',
    '[[ "$SHARD" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]',
    '[[ "$CANDIDATE_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]',
    '[[ "$CANDIDATE_SHA" =~ ^[a-f0-9]{40}$ ]]',
    '[[ "$TEST_FILE" =~ ^test/e2e/live/[A-Za-z0-9._-]+\\.test\\.ts$ ]]',
    '[[ "$ARTIFACT_LAYOUT" == "target-shard" || "$ARTIFACT_LAYOUT" == "flat-shard" ]]',
    'artifact_directory="e2e-artifacts/live/${TARGET_ID}"',
    'artifact_directory="${artifact_directory}-${SHARD}"',
    'artifact_directory="${artifact_directory}/${SHARD}"',
    'printf \'artifact_directory=%s\\n\' "$artifact_directory" >>"$GITHUB_OUTPUT"',
    'printf \'upload_name=%s\\n\' "$upload_name" >>"$GITHUB_OUTPUT"',
    'printf \'E2E_ARTIFACT_DIR=%s/%s\\n\' "$GITHUB_WORKSPACE_VALUE" "$artifact_directory" >>"$GITHUB_ENV"',
    'printf \'NEMOCLAW_E2E_SHARD=%s\\n\' "$SHARD" >>"$GITHUB_ENV"',
  ];
  if (
    executionPlan?.id !== "execution_plan" ||
    executionPlan.shell !== EXECUTION_PLAN_SHELL ||
    workflowSteps.indexOf(executionPlan ?? {}) !== 0 ||
    !isDeepStrictEqual(record(executionPlan.env), {
      ARTIFACT_LAYOUT: "${{ inputs.artifact_layout }}",
      BASH_ENV: "/dev/null",
      CANDIDATE_REPOSITORY: "${{ inputs.candidate_repository }}",
      CANDIDATE_SHA: "${{ inputs.candidate_sha }}",
      CATALOGUE_ID: "${{ inputs.catalogue_id }}",
      ENV: "/dev/null",
      GITHUB_WORKSPACE_VALUE: "${{ github.workspace }}",
      HOST_PACKAGES: "${{ inputs.host_packages }}",
      HOST_PREPARATION: "${{ inputs.host_preparation }}",
      INSTALL_MODE: "${{ inputs.install_mode }}",
      LC_ALL: "C",
      SHARD: "${{ inputs.shard }}",
      TARGET_ID: "${{ inputs.target_id }}",
      TEST_FILE: "${{ inputs.test_file }}",
    }) ||
    executionPlanFragments.some((fragment) => !executionPlanRun.includes(fragment))
  ) {
    errors.push(
      "standard E2E profile must derive validated execution paths before candidate checkout",
    );
  }
  const trustedSwap = requireStep(errors, workflowSteps, "Provision trusted Hermes E2E swap");
  if (
    trustedSwap?.if !== "${{ inputs.host_preparation == 'hermes-swap' }}" ||
    trustedSwap.id !== "trusted_hermes_swap" ||
    trustedSwap.shell !== EXECUTION_PLAN_SHELL ||
    trustedSwap.run !== TRUSTED_HERMES_SWAP_SCRIPT ||
    !isDeepStrictEqual(record(trustedSwap.env), {
      BASH_ENV: "/dev/null",
      CHECKOUT_SHA: "${{ inputs.checkout_sha }}",
      DISPATCH_SHA: "${{ github.sha }}",
      ENV: "/dev/null",
      EVENT_NAME: "${{ github.event_name }}",
      EXPECTED_WORKFLOW_SHA: "${{ inputs.workflow_sha }}",
      LC_ALL: "C",
      REF: "${{ github.ref }}",
      REPOSITORY: "${{ github.repository }}",
      RUNNER_ARCH_KIND: "${{ runner.arch }}",
      RUNNER_ENVIRONMENT_KIND: "${{ runner.environment }}",
      RUNNER_OS_KIND: "${{ runner.os }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    }) ||
    workflowSteps.indexOf(trustedSwap) !== 1
  ) {
    errors.push("standard E2E profile must preserve trusted Hermes swap before candidate checkout");
  }
  const checkout = workflowSteps.find((step) => step.uses?.startsWith("actions/checkout@"));
  requirePinnedAction(errors, checkout, "checkout");
  const checkoutWith = record(checkout?.with);
  if (
    checkout?.uses !== CHECKOUT ||
    checkoutWith.repository !== "${{ inputs.candidate_repository }}" ||
    checkoutWith.ref !== "${{ inputs.candidate_sha }}" ||
    checkoutWith["fetch-depth"] !== 0 ||
    checkoutWith["persist-credentials"] !== false ||
    workflowSteps.indexOf(checkout ?? {}) !== 2
  ) {
    errors.push("standard E2E profile must check out checkout_sha without credentials");
  }

  const auth = requireStep(errors, workflowSteps, "Authenticate to Docker Hub");
  if (auth?.uses !== E2E_ACTION_PROVENANCE.dockerAuth.reference) {
    errors.push("standard E2E profile must use the reviewed Docker Hub authentication action");
  }
  const authInputs = record(auth?.with);
  const expectedAuthInputs = {
    "auth-required": "${{ inputs.trusted_main && '1' || '0' }}",
    username: "${{ inputs.trusted_main && secrets.DOCKERHUB_USERNAME || '' }}",
    token: "${{ inputs.trusted_main && secrets.DOCKERHUB_TOKEN || '' }}",
  };
  for (const [name, expected] of Object.entries(expectedAuthInputs)) {
    if (authInputs[name] !== expected) {
      errors.push(`standard E2E profile Docker Hub ${name} must be guarded by trusted_main`);
    }
  }

  const prepare = requireStep(errors, workflowSteps, "Prepare E2E workspace");

  const hostDependencies = requireStep(errors, workflowSteps, "Install target host dependencies");
  if (
    hostDependencies?.if !== "${{ inputs.host_packages != '' }}" ||
    hostDependencies.uses !== E2E_ACTION_PROVENANCE.hostDependencies.reference ||
    record(hostDependencies.with).packages !== "${{ inputs.host_packages }}"
  ) {
    errors.push(
      "standard E2E profile must install only the planned host packages with the reviewed action",
    );
  }
  if (
    hostDependencies &&
    prepare &&
    workflowSteps.indexOf(hostDependencies) >= workflowSteps.indexOf(prepare)
  ) {
    errors.push("standard E2E profile must install host dependencies before workspace prep");
  }
  if (
    prepare?.uses !== E2E_ACTION_PROVENANCE.prepareWorkspace.reference ||
    record(prepare?.with)["build-cli"] !== "false"
  ) {
    errors.push("standard E2E profile must prepare once without rebuilding the CLI");
  }
  const restore = requireStep(errors, workflowSteps, "Restore exact-commit CLI artifact");
  if (
    restore?.if !== "${{ inputs.restore_cli }}" ||
    restore.uses !== E2E_ACTION_PROVENANCE.restoreCliArtifact.reference ||
    record(restore.with)["provenance-json"] !== "${{ inputs.cli_artifact_provenance }}"
  ) {
    errors.push("standard E2E profile must restore the planned exact-commit CLI artifact");
  }
  const managedCatalog = requireStep(
    errors,
    workflowSteps,
    "Materialize temporary managed-image catalog",
  );
  const managedCatalogRun = String(managedCatalog?.run ?? "");
  if (
    managedCatalog?.if !== "${{ inputs.managed_image_catalog != '' }}" ||
    managedCatalog.shell !== EXECUTION_PLAN_SHELL ||
    !isDeepStrictEqual(record(managedCatalog.env), {
      CANDIDATE_SHA: "${{ inputs.candidate_sha }}",
      MANAGED_IMAGE_CATALOG: "${{ inputs.managed_image_catalog }}",
      RESTORE_CLI: "${{ inputs.restore_cli && 'true' || 'false' }}",
    }) ||
    !managedCatalogRun.includes(".source.revision == $revision") ||
    !managedCatalogRun.includes("[.[].source.release] | unique | length") ||
    !managedCatalogRun.includes("[.[].source.cohort] | unique | length") ||
    !managedCatalogRun.includes('[[ "$RESTORE_CLI" == "true" ]]') ||
    !managedCatalogRun.includes(".source.release == $release") ||
    !managedCatalogRun.includes(
      "managed-image catalog source identity does not match the candidate",
    ) ||
    !managedCatalogRun.includes(
      "managed-image catalog release does not match the restored CLI",
    ) ||
    !managedCatalogRun.includes("NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG") ||
    managedCatalogRun.includes("NEMOCLAW_E2E_EXACT_RELEASE") ||
    managedCatalogRun.includes(".source.release = $release") ||
    workflowSteps.indexOf(managedCatalog ?? {}) !== workflowSteps.indexOf(restore ?? {}) + 1
  ) {
    errors.push(
      "standard E2E profile must materialize only the exact-candidate managed-image catalog",
    );
  }
  const cloudflared = requireStep(errors, workflowSteps, "Install reviewed cloudflared");
  const cloudflaredRun = String(cloudflared?.run ?? "");
  if (
    cloudflared?.if !== "${{ inputs.cloudflared }}" ||
    cloudflared.shell !== EXECUTION_PLAN_SHELL ||
    !isDeepStrictEqual(record(cloudflared.env), {
      CLOUDFLARED_VERSION: "2026.6.1",
      CLOUDFLARED_DEB_SHA256:
        "ccd02ec216c62bfa573395d8f72cb2e91e95cbdf8726a8acc06b3e2d9aa31526",
    }) ||
    !cloudflaredRun.includes(
      'https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb',
    ) ||
    !cloudflaredRun.includes("sha256sum -c -") ||
    !cloudflaredRun.includes('dpkg-deb -f "${cloudflared_deb}" Package') ||
    !cloudflaredRun.includes('"${architecture}" != "amd64"') ||
    cloudflaredRun.includes("command -v cloudflared") ||
    workflowSteps.indexOf(cloudflared ?? {}) !== workflowSteps.indexOf(managedCatalog ?? {}) + 1
  ) {
    errors.push("standard E2E profile must install only the reviewed cloudflared package");
  }
  const rebuildSwap = requireStep(errors, workflowSteps, "Add swap for Hermes image rebuild");
  const rebuildSwapRun = String(rebuildSwap?.run ?? "");
  const rebuildSwapFragments = [
    '[[ "${REPOSITORY}" != "NVIDIA/NemoClaw" ]]',
    '[[ "${EVENT_NAME}" == "push" && "${REF}" != "refs/heads/main" ]]',
    '[[ "${EVENT_NAME}" == "workflow_dispatch" && "${REF}" != refs/heads/* ]]',
    '[[ "${RUNNER_ENVIRONMENT_KIND}" != "github-hosted"',
    'fail "refusing unexpected pre-existing rebuild swap path"',
    "required_disk_bytes=$((swap_file_bytes + reserve_bytes))",
    "trap cleanup_partial_swap EXIT",
    '/usr/bin/sudo -n /usr/bin/fallocate -l "${swap_file_bytes}" "${swap_file}"',
    '/usr/bin/sudo -n /usr/sbin/swapoff "${swap_file}" || true',
    'fail "rebuild swap did not become active"',
  ];
  if (
    rebuildSwap?.if !== "${{ inputs.host_preparation == 'rebuild-swap' }}" ||
    rebuildSwap.shell !== EXECUTION_PLAN_SHELL ||
    !isDeepStrictEqual(record(rebuildSwap.env), {
      BASH_ENV: "/dev/null",
      CHECKOUT_SHA: "${{ inputs.checkout_sha }}",
      DISPATCH_SHA: "${{ github.sha }}",
      ENV: "/dev/null",
      EVENT_NAME: "${{ github.event_name }}",
      EXPECTED_WORKFLOW_SHA: "${{ inputs.workflow_sha }}",
      LC_ALL: "C",
      REF: "${{ github.ref }}",
      REPOSITORY: "${{ github.repository }}",
      RUNNER_ARCH_KIND: "${{ runner.arch }}",
      RUNNER_ENVIRONMENT_KIND: "${{ runner.environment }}",
      RUNNER_OS_KIND: "${{ runner.os }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    }) ||
    rebuildSwapFragments.some((fragment) => !rebuildSwapRun.includes(fragment)) ||
    workflowSteps.indexOf(rebuildSwap ?? {}) !== workflowSteps.indexOf(cloudflared ?? {}) + 1
  ) {
    errors.push("standard E2E profile must add the reviewed Hermes rebuild swap after CLI restore");
  }
  const comparisonInitialize = requireStep(
    errors,
    workflowSteps,
    "Initialize runner comparison telemetry",
  );
  if (
    comparisonInitialize?.if !== "${{ inputs.runner_comparison && inputs.trusted_main }}" ||
    comparisonInitialize["continue-on-error"] !== true ||
    comparisonInitialize.run !== "npx tsx tools/e2e/runner-comparison.mts initialize"
  ) {
    errors.push("standard E2E profile must initialize only planned trusted-main runner telemetry");
  }

  const authenticatedInstall = requireStep(errors, workflowSteps, "Install OpenShell CLI");
  if (
    authenticatedInstall?.if !== "${{ inputs.install_mode == 'authenticated' }}" ||
    record(authenticatedInstall.env).NEMOCLAW_NON_INTERACTIVE !==
      "${{ inputs.install_non_interactive && '1' || '' }}" ||
    authenticatedInstall.run !== "bash scripts/install-openshell.sh"
  ) {
    errors.push("standard E2E profile must gate authenticated OpenShell installation by mode");
  }
  const credentialFreeInstall = requireStep(
    errors,
    workflowSteps,
    "Install OpenShell CLI without workflow credentials",
  );
  if (
    credentialFreeInstall?.if !== "${{ inputs.install_mode == 'credential-free' }}" ||
    record(credentialFreeInstall.env).NEMOCLAW_NON_INTERACTIVE !==
      "${{ inputs.install_non_interactive && '1' || '' }}" ||
    !String(credentialFreeInstall.run).includes("env -u DOCKER_CONFIG") ||
    !String(credentialFreeInstall.run).includes("-u NVIDIA_INFERENCE_API_KEY")
  ) {
    errors.push(
      "standard E2E profile must remove workflow credentials from credential-free installs",
    );
  }

  const execute = requireStep(errors, workflowSteps, "Run catalogue E2E target");
  const executeEnv = record(execute?.env);
  if (
    !String(execute?.run).includes('if [ "$INSTALL_MODE" != "none" ]; then') ||
    !String(execute?.run).includes('OPENSHELL_BIN="$(command -v openshell)"') ||
    !String(execute?.run).includes('"$OPENSHELL_BIN" --version') ||
    !String(execute?.run).includes(
      'npx tsx tools/e2e/target-catalogue.mts run "$CATALOGUE_ID" "$TEST_FILE"',
    ) ||
    executeEnv.INSTALL_MODE !== "${{ inputs.install_mode }}" ||
    executeEnv.CATALOGUE_ID !== "${{ inputs.catalogue_id }}" ||
    executeEnv.TEST_FILE !== "${{ inputs.test_file }}" ||
    executeEnv.NVIDIA_API_KEY !== "${{ inputs.trusted_main && secrets.NVIDIA_API_KEY || '' }}" ||
    executeEnv.NVIDIA_INFERENCE_API_KEY !==
      "${{ inputs.trusted_main && secrets.NVIDIA_INFERENCE_API_KEY || '' }}" ||
    executeEnv.COMPATIBLE_API_KEY !==
      "${{ inputs.compatible_api_key && inputs.trusted_main && secrets.NVIDIA_INFERENCE_API_KEY || '' }}" ||
    executeEnv.BRAVE_API_KEY !==
      "${{ inputs.trusted_main && secrets.BRAVE_API_KEY || '' }}" ||
    executeEnv.GITHUB_TOKEN !==
      "${{ inputs.github_token && inputs.trusted_main && github.token || '' }}"
  ) {
    errors.push("standard E2E profile must run the planned catalogue target with guarded secrets");
  }

  const skillUpload = requireStep(errors, workflowSteps, "Upload skill-agent artifacts");
  if (
    skillUpload?.if !==
      "${{ always() && steps.execution_plan.outcome == 'success' && inputs.catalogue_id == 'skill-agent' }}" ||
    skillUpload.uses !== E2E_ACTION_PROVENANCE.uploadArtifacts.reference ||
    !isDeepStrictEqual(record(skillUpload.with), {
      name: "${{ steps.execution_plan.outputs.upload_name }}",
      path: SKILL_AGENT_UPLOAD_PATH,
    })
  ) {
    errors.push(
      "standard E2E profile must upload only the fixed skill-agent artifact set with the reviewed action",
    );
  }
  const upload = requireStep(errors, workflowSteps, "Upload E2E artifacts");
  if (
    upload?.if !==
      "${{ always() && steps.execution_plan.outcome == 'success' && inputs.catalogue_id != 'skill-agent' }}" ||
    upload.uses !== E2E_ACTION_PROVENANCE.uploadArtifacts.reference ||
    !isDeepStrictEqual(record(upload.with), {
      name: "${{ steps.execution_plan.outputs.upload_name }}",
      path: "${{ steps.execution_plan.outputs.artifact_directory }}/",
    })
  ) {
    errors.push(
      "standard E2E profile must upload only its validated artifact path with the reviewed action",
    );
  }
  const comparisonFinalize = requireStep(
    errors,
    workflowSteps,
    "Finalize runner comparison telemetry",
  );
  if (
    comparisonFinalize?.if !==
      "${{ always() && inputs.runner_comparison && inputs.trusted_main }}" ||
    comparisonFinalize["continue-on-error"] !== true ||
    comparisonFinalize.run !== "npx tsx tools/e2e/runner-comparison.mts finalize" ||
    workflowSteps.indexOf(comparisonFinalize ?? {}) >= workflowSteps.indexOf(upload ?? {})
  ) {
    errors.push(
      "standard E2E profile must finalize planned runner telemetry before artifact upload",
    );
  }
  const evidence = requireStep(errors, workflowSteps, "Write E2E evidence manifest");
  const evidenceEnv = record(evidence?.env);
  const evidenceRun = String(evidence?.run ?? "");
  if (
    evidence?.if !== "${{ always() && steps.execution_plan.outcome == 'success' }}" ||
    evidenceEnv.ARTIFACT_DIRECTORY !== "${{ steps.execution_plan.outputs.artifact_directory }}" ||
    evidenceEnv.CANDIDATE_SHA !== "${{ inputs.candidate_sha }}" ||
    evidenceEnv.WORKFLOW_SHA !== "${{ github.workflow_sha }}" ||
    evidenceEnv.JOB_STATUS !== "${{ job.status }}" ||
    !evidenceRun.includes('kind: "nemoclaw-e2e-evidence-v1"') ||
    !evidenceRun.includes("successful E2E target produced no product evidence") ||
    !evidenceRun.includes('>"$ARTIFACT_DIRECTORY/evidence-manifest.json"') ||
    workflowSteps.indexOf(evidence ?? {}) >= workflowSteps.indexOf(upload ?? {})
  ) {
    errors.push(
      "standard E2E profile must write exact-commit product evidence before artifact upload",
    );
  }
  const cleanup = namedStep(workflowSteps, "Clean up Docker auth");
  if (
    cleanup?.if !== "always()" ||
    cleanup.run !== "bash .github/scripts/docker-auth-cleanup.sh" ||
    workflowSteps.at(-1) !== cleanup
  ) {
    errors.push("standard E2E profile must always clean up Docker authentication last");
  }
}

export function validateStandardProfileWorkflowBoundary(
  workflow: WorkflowRecord,
  profilePath = DEFAULT_PROFILE_PATH,
): string[] {
  const errors: string[] = [];
  validateProfileCallers(errors, workflow);
  validateProfileWorkflow(errors, record(YAML.parse(readFileSync(profilePath, "utf8"))));
  return errors;
}
