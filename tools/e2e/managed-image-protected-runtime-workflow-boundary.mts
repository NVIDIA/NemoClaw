// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  env?: WorkflowRecord;
  name?: string;
  run?: string;
  uses?: string;
  with?: WorkflowRecord;
};

const JOB_ID = "managed-image-protected-runtime";
const SELECTOR =
  "${{ always() && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && needs['generate-matrix'].result == 'success' && needs['managed-image-multiarch-startup'].result == 'success' && contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'managed-image-protected-runtime') }}";
const ACTIVATION_PATH = "ci/protected-managed-image-runtime-activation-v1.json";
const LIVE_TEST_PATH = "test/e2e/live/managed-image-protected-runtime.test.ts";
const REGISTRY_IMAGE =
  "docker.io/library/registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const REVIEWED_HERMES_PLATFORM_ACTION = "./.github/actions/resolve-reviewed-hermes-platform";
const GUARDED_NVIDIA_API_KEY =
  "${{ github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && (inputs.checkout_sha == '' || needs.generate-matrix.outputs.e2e_credentials_allowed == 'true') && secrets.NVIDIA_API_KEY || '' }}";

// Keep lane-specific trust assertions explicit: the multiarch lane executes
// candidate code directly, while this GPU lane keeps secrets in trusted code
// and isolates candidate source. The workflow-boundary aggregate runs both
// validators, which fail closed on the common job invariants without weakening
// either boundary into a generic lowest-common-denominator validator.

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function steps(value: unknown): WorkflowStep[] {
  return Array.isArray(value) ? (value as WorkflowStep[]) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requireStep(
  errors: string[],
  workflowSteps: readonly WorkflowStep[],
  name: string,
): WorkflowStep | undefined {
  const matches = workflowSteps.filter((step) => step.name === name);
  if (matches.length !== 1) errors.push(`${JOB_ID} must define exactly one '${name}' step`);
  return matches[0];
}

function requireValues(
  errors: string[],
  subject: string,
  actual: WorkflowRecord,
  expected: Readonly<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) errors.push(`${subject} must bind ${key} to ${String(value)}`);
  }
}

function requireFragments(
  errors: string[],
  step: WorkflowStep | undefined,
  fragments: readonly string[],
): void {
  const run = text(step?.run);
  for (const fragment of fragments) {
    if (!run.includes(fragment)) {
      errors.push(`${JOB_ID} step '${step?.name ?? "missing"}' must include ${fragment}`);
    }
  }
}

function requireOrderedSteps(
  errors: string[],
  workflowSteps: readonly WorkflowStep[],
  names: readonly string[],
): void {
  const indexes = names.map((name) => workflowSteps.findIndex((step) => step.name === name));
  if (indexes.some((index) => index < 0)) return;
  if (indexes.some((index, offset) => offset > 0 && index <= indexes[offset - 1])) {
    errors.push(`${JOB_ID} protected qualification and cleanup steps drifted`);
  }
}

export function validateManagedImageProtectedRuntimeWorkflow(workflow: WorkflowRecord): string[] {
  const errors: string[] = [];
  const job = record(record(workflow.jobs)[JOB_ID]);
  if (Object.keys(job).length === 0) return [`workflow missing ${JOB_ID} job`];

  if (!isDeepStrictEqual(job.needs, ["generate-matrix", "managed-image-multiarch-startup"])) {
    errors.push(`${JOB_ID} must depend on generate-matrix and managed-image-multiarch-startup`);
  }
  if (job.if !== SELECTOR) errors.push(`${JOB_ID} must use the trusted execution plan`);
  if (job["runs-on"] !== "linux-amd64-gpu-rtxpro6000-latest-1") {
    errors.push(`${JOB_ID} must run on the protected amd64 GPU runner`);
  }
  if (job["timeout-minutes"] !== 300) errors.push(`${JOB_ID} must keep the 300 minute timeout`);
  if (!isDeepStrictEqual(job.permissions, { contents: "read" })) {
    errors.push(`${JOB_ID} permissions must be exactly contents: read`);
  }
  if (job["continue-on-error"] !== undefined) {
    errors.push(`${JOB_ID} must not weaken failures with continue-on-error`);
  }

  const jobEnv = record(job.env);
  requireValues(errors, `${JOB_ID} env`, jobEnv, {
    E2E_ARTIFACT_DIR: "${{ github.workspace }}/e2e-artifacts/live/managed-image-protected-runtime",
    E2E_JOB: "1",
    E2E_TARGET_ID: JOB_ID,
    E2E_WORKLOAD_SOURCE: "managed-image",
    RELEASE_E2E_ACTIVATION_PATH: ACTIVATION_PATH,
    NEMOCLAW_E2E_EXPECTED_SHA: "${{ inputs.checkout_sha }}",
    NEMOCLAW_E2E_SHARD: "linux-amd64-gpu",
    NEMOCLAW_E2E_TESTED_ROOT: "${{ github.workspace }}/.candidate-runtime",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_BASE_SHA:
      "${{ inputs.base_sha || github.event.before || github.sha }}",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE:
      "${{ github.workspace }}/.protected-managed-image-build-cache/linux-amd64",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE_ARTIFACT:
      "protected-managed-image-build-cache-${{ github.run_id }}-${{ inputs.checkout_sha || github.sha }}",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT:
      "protected-${{ github.run_id }}-${{ github.run_attempt }}",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT:
      "${{ github.workspace }}/e2e-artifacts/live/managed-image-protected-runtime/contracts.json",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_PLATFORM: "linux/amd64",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA:
      "${{ inputs.workflow_sha || github.workflow_sha }}",
    NEMOCLAW_PROTECTED_REGISTRY_NAME:
      "nemoclaw-managed-runtime-${{ github.run_id }}-${{ github.run_attempt }}",
    NEMOCLAW_RUN_LIVE_E2E: "1",
  });
  if (jobEnv.NVIDIA_API_KEY !== undefined) {
    errors.push(`${JOB_ID} must not expose NVIDIA_API_KEY at job scope`);
  }

  const workflowSteps = steps(job.steps);
  const guard = requireStep(
    errors,
    workflowSteps,
    "Validate protected runtime exact-head dispatch",
  );
  requireValues(errors, `${JOB_ID} exact-head guard env`, record(guard?.env), {
    BASE_SHA: "${{ inputs.base_sha || github.event.before || github.sha }}",
    CHECKOUT_SHA: "${{ inputs.checkout_sha || github.sha }}",
    EVENT_NAME: "${{ github.event_name }}",
    EXPECTED_WORKFLOW_SHA: "${{ inputs.workflow_sha || github.workflow_sha }}",
    REF: "${{ github.ref }}",
    REPOSITORY: "${{ github.repository }}",
    RUNNER_ARCH_KIND: "${{ runner.arch }}",
    WORKFLOW_SHA: "${{ github.workflow_sha }}",
  });
  requireFragments(errors, guard, [
    '"NVIDIA/NemoClaw"',
    '"refs/heads/main"',
    '"push"',
    '"workflow_dispatch"',
    '[[ "$CHECKOUT_SHA" =~ ^[a-f0-9]{40}$ && "$BASE_SHA" =~ ^[a-f0-9]{40}$ ]]',
    '"$WORKFLOW_SHA" == "$EXPECTED_WORKFLOW_SHA"',
    '"$RUNNER_ARCH_KIND" == "X64"',
  ]);

  const checkouts = workflowSteps.filter((step) => text(step.uses).startsWith("actions/checkout@"));
  if (checkouts.length !== 2) {
    errors.push(`${JOB_ID} must define one trusted checkout and one isolated candidate checkout`);
  }
  const trustedCheckout = requireStep(
    errors,
    workflowSteps,
    "Checkout trusted protected runtime qualification",
  );
  const candidateCheckout = requireStep(
    errors,
    workflowSteps,
    "Checkout exact protected runtime candidate source",
  );
  const checkoutAction = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
  if (trustedCheckout?.uses !== checkoutAction || candidateCheckout?.uses !== checkoutAction) {
    errors.push(`${JOB_ID} must pin both trusted and candidate checkouts`);
  }
  requireValues(errors, `${JOB_ID} trusted checkout`, record(trustedCheckout?.with), {
    repository: "${{ github.repository }}",
    ref: "${{ inputs.workflow_sha || github.workflow_sha }}",
    "fetch-depth": 0,
    "persist-credentials": false,
  });
  requireValues(errors, `${JOB_ID} candidate checkout`, record(candidateCheckout?.with), {
    repository: "${{ inputs.checkout_repository || github.repository }}",
    ref: "${{ inputs.checkout_sha || github.sha }}",
    path: ".candidate-runtime",
    "fetch-depth": 0,
    "persist-credentials": false,
  });

  const cacheDownload = requireStep(
    errors,
    workflowSteps,
    "Download exact protected runtime build cache",
  );
  if (
    cacheDownload?.uses !== "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
  ) {
    errors.push(`${JOB_ID} must pin the reviewed build cache download action`);
  }
  requireValues(errors, `${JOB_ID} build cache download`, record(cacheDownload?.with), {
    name: "${{ env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE_ARTIFACT }}",
    path: "${{ env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE }}",
  });

  const buildx = requireStep(errors, workflowSteps, "Set up protected runtime Buildx");
  if (buildx?.uses !== "docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c") {
    errors.push(`${JOB_ID} must pin the reviewed Buildx setup action`);
  }
  requireValues(errors, `${JOB_ID} Buildx setup`, record(buildx?.with), {
    "driver-opts": "network=host",
    "buildkitd-config-inline": '[registry."localhost:5000"]\n  http = true\n',
  });

  const prepare = requireStep(errors, workflowSteps, "Prepare E2E workspace");
  if (
    prepare?.uses !==
    "NVIDIA/NemoClaw/.github/actions/prepare-e2e@f6304bc25fc35bfaa441c8c2fbfee38f72805a75"
  ) {
    errors.push(`${JOB_ID} must pin the trusted E2E preparation action`);
  }
  if (prepare?.with !== undefined) {
    errors.push(`${JOB_ID} must use the default CLI build`);
  }

  const activation = requireStep(
    errors,
    workflowSteps,
    "Validate protected runtime activation contract",
  );
  requireFragments(errors, activation, [
    'candidate_root=".candidate-runtime"',
    `activation="$candidate_root/${ACTIVATION_PATH}"`,
    '[[ "$(git -C "$candidate_root" rev-parse --verify HEAD)" == "$CHECKOUT_SHA" ]]',
    '[[ -f "$activation" && ! -L "$activation" ]]',
    '(keys | sort) == ["agents", "contractVersion", "jobId", "platform", "providers"]',
    '.agents == ["openclaw", "hermes", "langchain-deepagents-code"]',
    '.platform == "linux/amd64"',
    '.providers == ["ollama", "nim", "vllm"]',
  ]);

  const hermesBase = requireStep(
    errors,
    workflowSteps,
    "Resolve reviewed Hermes runtime base image",
  );
  if (hermesBase?.uses !== REVIEWED_HERMES_PLATFORM_ACTION) {
    errors.push(`${JOB_ID} must use the shared reviewed Hermes platform resolver`);
  }
  requireValues(errors, `${JOB_ID} Hermes platform resolver`, record(hermesBase?.with), {
    "dockerfile-path": ".candidate-runtime/agents/hermes/Dockerfile",
    platform: "linux/amd64",
  });

  const bases = requireStep(errors, workflowSteps, "Resolve exact amd64 runtime base images");
  requireFragments(errors, bases, [
    'docker buildx imagetools inspect "$alias" --raw',
    '.platform.os == "linux" and .platform.architecture == "amd64"',
    'reference="${repository}@${digest}"',
    '"sha256:$(sha256sum "$exact_raw" | awk \'{print $1}\')" == "$digest"',
    "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
    "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest",
  ]);
  if (text(bases?.run).includes("ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest")) {
    errors.push(`${JOB_ID} must resolve Hermes from the immutable reviewed Dockerfile index`);
  }

  const registry = requireStep(errors, workflowSteps, "Start isolated protected runtime registry");
  requireFragments(errors, registry, [
    'docker container inspect "$NEMOCLAW_PROTECTED_REGISTRY_NAME"',
    "http://127.0.0.1:5000/v2/",
    "io.nvidia.nemoclaw.e2e-owner=${NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT}",
    "--publish 127.0.0.1:5000:5000",
    REGISTRY_IMAGE,
  ]);

  const build = requireStep(
    errors,
    workflowSteps,
    "Build exact all-agent protected runtime images",
  );
  requireFragments(errors, build, [
    "scripts/checks/build-protected-managed-images.sh",
    '--revision "$CHECKOUT_SHA"',
    '--cohort "$NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT"',
    "--platform linux/amd64",
    '--source-root "$GITHUB_WORKSPACE/.candidate-runtime"',
    '--cache-from "$NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE"',
    '--openclaw-base "$BASE_OPENCLAW"',
    '--hermes-base "$BASE_HERMES"',
    '--dcode-base "$BASE_DCODE"',
  ]);
  requireValues(errors, `${JOB_ID} protected runtime build bases`, record(build?.env), {
    BASE_HERMES:
      "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${{ steps.runtime-hermes-base.outputs.digest }}",
  });

  const install = requireStep(errors, workflowSteps, "Install OpenShell CLI");
  requireFragments(errors, install, [
    "env -u DOCKER_CONFIG",
    "-u NVIDIA_API_KEY",
    "-u NVIDIA_INFERENCE_API_KEY",
    "bash scripts/install-openshell.sh",
  ]);

  const qualification = requireStep(
    errors,
    workflowSteps,
    "Run all-agent GPU, local inference, rollback, and cleanup qualification",
  );
  requireValues(errors, `${JOB_ID} qualification env`, record(qualification?.env), {
    NVIDIA_API_KEY: GUARDED_NVIDIA_API_KEY,
  });
  const secretBearingSteps = workflowSteps.filter(
    (step) => record(step.env).NVIDIA_API_KEY !== undefined,
  );
  if (secretBearingSteps.length !== 1 || secretBearingSteps[0] !== qualification) {
    errors.push(`${JOB_ID} must expose NVIDIA_API_KEY only to trusted qualification code`);
  }
  requireFragments(errors, qualification, [
    '[[ "$(git rev-parse --verify HEAD)" == "$NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA" ]]',
    'export OPENSHELL_BIN="$(command -v openshell)"',
    "tools/e2e/live-vitest-invocation.mts run",
    `--test-path ${LIVE_TEST_PATH}`,
  ]);
  if (text(qualification?.run).includes(".candidate-runtime")) {
    errors.push(`${JOB_ID} trusted qualification must not execute candidate checkout paths`);
  }

  const cleanup = requireStep(errors, workflowSteps, "Remove isolated protected runtime registry");
  if (cleanup?.if !== "always()") errors.push(`${JOB_ID} registry cleanup must always run`);
  requireFragments(errors, cleanup, [
    "io.nvidia.nemoclaw.e2e-owner",
    '[[ "$owner" == "$NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT" ]]',
    'docker rm -f "$NEMOCLAW_PROTECTED_REGISTRY_NAME"',
    "http://127.0.0.1:5000/v2/",
  ]);

  const upload = requireStep(
    errors,
    workflowSteps,
    "Upload protected managed-image runtime artifacts",
  );
  if (upload?.if !== "always()") errors.push(`${JOB_ID} artifact upload must always run`);
  requireValues(errors, `${JOB_ID} artifact upload`, record(upload?.with), {
    name: "e2e-managed-image-protected-runtime",
    path: "e2e-artifacts/live/managed-image-protected-runtime/",
  });
  requireStep(errors, workflowSteps, "Clean up Docker auth");
  requireOrderedSteps(errors, workflowSteps, [
    "Validate protected runtime exact-head dispatch",
    "Checkout trusted protected runtime qualification",
    "Checkout exact protected runtime candidate source",
    "Download exact protected runtime build cache",
    "Prepare E2E workspace",
    "Validate protected runtime activation contract",
    "Resolve reviewed Hermes runtime base image",
    "Resolve exact amd64 runtime base images",
    "Start isolated protected runtime registry",
    "Build exact all-agent protected runtime images",
    "Install OpenShell CLI",
    "Run all-agent GPU, local inference, rollback, and cleanup qualification",
    "Remove isolated protected runtime registry",
    "Upload protected managed-image runtime artifacts",
    "Clean up Docker auth",
  ]);

  return errors;
}
