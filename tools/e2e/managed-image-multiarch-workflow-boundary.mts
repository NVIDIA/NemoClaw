// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import * as importedProtectedManagedImageContract from "../../scripts/checks/protected-managed-image-contract.ts";

// The root TypeScript package is exposed as CJS under the exact
// `node --import tsx` workflow execution mode, but as an ESM namespace under
// Vitest. Normalize both representations before reading shared identifiers.
const protectedManagedImageContract = (
  "default" in importedProtectedManagedImageContract &&
  importedProtectedManagedImageContract.default
    ? importedProtectedManagedImageContract.default
    : importedProtectedManagedImageContract
) as typeof import("../../scripts/checks/protected-managed-image-contract.ts");

const { PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH, PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID } =
  protectedManagedImageContract;

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  env?: WorkflowRecord;
  name?: string;
  run?: string;
  uses?: string;
  with?: WorkflowRecord;
};

const JOB_ID = PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID;
const PROTECTED_RUNTIME_JOB_ID = "managed-image-protected-runtime";
const SELECTOR = `\${{ github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && (contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), '${JOB_ID}') || contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), '${PROTECTED_RUNTIME_JOB_ID}')) }}`;
const ACTIVATION_PATH = PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH;
const DIRECT_TEST_PATH = "test/e2e/live/managed-image-multiarch-startup.test.ts";
const REGISTRY_IMAGE =
  "docker.io/library/registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const TRUSTED_HERMES_RESOLVER_ROOT = ".trusted-hermes-resolver";
const REVIEWED_HERMES_PLATFORM_ACTION = `./${TRUSTED_HERMES_RESOLVER_ROOT}/.github/actions/resolve-reviewed-hermes-platform`;

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function workflowSteps(value: unknown): WorkflowStep[] {
  return Array.isArray(value) ? (value as WorkflowStep[]) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requireStep(
  errors: string[],
  steps: readonly WorkflowStep[],
  name: string,
): WorkflowStep | undefined {
  const matching = steps.filter((step) => step.name === name);
  if (matching.length !== 1) {
    errors.push(`${JOB_ID} must define exactly one '${name}' step`);
  }
  return matching[0];
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
  if (!step) return;
  const run = text(step.run);
  for (const fragment of fragments) {
    if (!run.includes(fragment)) {
      errors.push(`${JOB_ID} step '${step.name}' must include ${fragment}`);
    }
  }
}

function requireOrderedSteps(
  errors: string[],
  steps: readonly WorkflowStep[],
  names: readonly string[],
): void {
  const indexes = names.map((name) => steps.findIndex((step) => step.name === name));
  if (indexes.some((index) => index < 0)) return;
  if (indexes.some((index, offset) => offset > 0 && index <= indexes[offset - 1])) {
    errors.push(
      `${JOB_ID} protected build, execution, cleanup, validation, and upload steps drifted`,
    );
  }
}

export function validateManagedImageMultiarchWorkflow(workflow: WorkflowRecord): string[] {
  const errors: string[] = [];
  const job = record(record(workflow.jobs)[JOB_ID]);
  if (Object.keys(job).length === 0) {
    return [`workflow missing ${JOB_ID} job`];
  }

  if (job.needs !== "generate-matrix") errors.push(`${JOB_ID} must depend on generate-matrix`);
  if (job.if !== SELECTOR) errors.push(`${JOB_ID} must use the trusted execution plan`);
  if (job["runs-on"] !== "${{ matrix.runner }}") {
    errors.push(`${JOB_ID} must run on the native matrix runner`);
  }
  if (job["timeout-minutes"] !== 210) errors.push(`${JOB_ID} must keep the 210 minute timeout`);
  if (record(job.permissions).contents !== "read") {
    errors.push(`${JOB_ID} permissions must be contents: read`);
  }
  if (job["continue-on-error"] !== undefined) {
    errors.push(`${JOB_ID} must not weaken failures with continue-on-error`);
  }

  const expectedStrategy = {
    "fail-fast": false,
    matrix: {
      include: [
        {
          platform: "linux/amd64",
          runner: "ubuntu-24.04",
          shard: "linux-amd64",
          environment_or_inference_endpoint: "AMD64 Ubuntu; exact managed image startup",
          coverage_variant: "linux-amd64",
        },
        {
          platform: "linux/arm64",
          runner: "ubuntu-24.04-arm",
          shard: "linux-arm64",
          environment_or_inference_endpoint: "Arm64 Ubuntu; exact managed image startup",
          coverage_variant: "linux-arm64",
        },
      ],
    },
  };
  if (!isDeepStrictEqual(job.strategy, expectedStrategy)) {
    errors.push(`${JOB_ID} must preserve the native amd64 and arm64 runner matrix`);
  }

  requireValues(errors, `${JOB_ID} env`, record(job.env), {
    E2E_ARTIFACT_DIR:
      "${{ github.workspace }}/e2e-artifacts/live/managed-image-multiarch-startup/${{ matrix.shard }}",
    E2E_JOB: "1",
    E2E_TARGET_ID: JOB_ID,
    NEMOCLAW_E2E_EXPECTED_SHA: "${{ inputs.checkout_sha }}",
    NEMOCLAW_E2E_SHARD: "${{ matrix.shard }}",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_BASE_SHA:
      "${{ inputs.base_sha || github.event.before || github.sha }}",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE:
      "${{ github.workspace }}/.protected-managed-image-build-cache/${{ matrix.shard }}",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE_ARTIFACT:
      "protected-managed-image-build-cache-${{ github.run_id }}-${{ inputs.checkout_sha || github.sha }}",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT:
      "protected-${{ github.run_id }}-${{ github.run_attempt }}",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_HEAD_SHA: "${{ inputs.checkout_sha || github.sha }}",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT:
      "${{ github.workspace }}/e2e-artifacts/live/managed-image-multiarch-startup/${{ matrix.shard }}/contracts.json",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_EVIDENCE:
      "${{ github.workspace }}/e2e-artifacts/live/managed-image-multiarch-startup/${{ matrix.shard }}/evidence.json",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_PLATFORM: "${{ matrix.platform }}",
    NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA:
      "${{ inputs.workflow_sha || github.workflow_sha }}",
    NEMOCLAW_PROTECTED_REGISTRY_NAME:
      "nemoclaw-managed-${{ matrix.shard }}-${{ github.run_id }}-${{ github.run_attempt }}",
    NEMOCLAW_RUN_LIVE_E2E: "1",
  });

  const steps = workflowSteps(job.steps);
  const guard = requireStep(errors, steps, "Validate protected exact-head dispatch");
  requireValues(errors, `${JOB_ID} exact-head guard env`, record(guard?.env), {
    BASE_SHA: "${{ inputs.base_sha || github.event.before || github.sha }}",
    CHECKOUT_SHA: "${{ inputs.checkout_sha || github.sha }}",
    EVENT_NAME: "${{ github.event_name }}",
    EXPECTED_WORKFLOW_SHA: "${{ inputs.workflow_sha || github.workflow_sha }}",
    PLATFORM: "${{ matrix.platform }}",
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
    "linux/amd64:X64 | linux/arm64:ARM64",
  ]);

  const checkouts = steps.filter((step) => text(step.uses).startsWith("actions/checkout@"));
  if (checkouts.length !== 2) {
    errors.push(`${JOB_ID} must define one candidate checkout and one trusted resolver checkout`);
  }
  const candidateCheckout = requireStep(
    errors,
    steps,
    "Checkout protected managed-image candidate source",
  );
  const trustedResolverPath = requireStep(
    errors,
    steps,
    "Validate trusted Hermes resolver checkout path",
  );
  const trustedResolverCheckout = requireStep(errors, steps, "Checkout trusted Hermes resolver");
  if (
    candidateCheckout?.uses !== CHECKOUT_ACTION ||
    trustedResolverCheckout?.uses !== CHECKOUT_ACTION
  ) {
    errors.push(`${JOB_ID} must pin the candidate and trusted resolver checkouts`);
  }
  requireValues(errors, `${JOB_ID} candidate checkout`, record(candidateCheckout?.with), {
    repository: "${{ inputs.checkout_repository || github.repository }}",
    ref: "${{ inputs.checkout_sha || github.sha }}",
    "fetch-depth": 0,
    "persist-credentials": false,
  });
  requireFragments(errors, trustedResolverPath, [
    `trusted_resolver_root="$GITHUB_WORKSPACE/${TRUSTED_HERMES_RESOLVER_ROOT}"`,
    '[[ ! -e "$trusted_resolver_root" && ! -L "$trusted_resolver_root" ]]',
  ]);
  requireValues(
    errors,
    `${JOB_ID} trusted Hermes resolver checkout`,
    record(trustedResolverCheckout?.with),
    {
      repository: "${{ github.repository }}",
      ref: "${{ inputs.workflow_sha || github.workflow_sha }}",
      path: TRUSTED_HERMES_RESOLVER_ROOT,
      "sparse-checkout": ".github/actions/resolve-reviewed-hermes-platform",
      "fetch-depth": 1,
      "persist-credentials": false,
    },
  );

  const buildx = requireStep(errors, steps, "Set up protected managed-image Buildx");
  if (buildx?.uses !== "docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c") {
    errors.push(`${JOB_ID} must pin the reviewed Buildx setup action`);
  }
  requireValues(errors, `${JOB_ID} Buildx setup`, record(buildx?.with), {
    "driver-opts": "network=host",
    "buildkitd-config-inline": '[registry."localhost:5000"]\n  http = true\n',
  });

  const activation = requireStep(errors, steps, "Validate candidate activation contract");
  requireFragments(errors, activation, [
    `activation="${ACTIVATION_PATH}"`,
    '[[ "$(git rev-parse --verify HEAD)" == "$CHECKOUT_SHA" ]]',
    '[[ -f "$activation" && ! -L "$activation" ]]',
    '(keys | sort) == ["agents", "contractVersion", "jobId", "platforms"]',
    '.agents == ["openclaw", "hermes", "langchain-deepagents-code"]',
    '.platforms == ["linux/amd64", "linux/arm64"]',
  ]);

  const hermesBase = requireStep(errors, steps, "Resolve reviewed Hermes platform base image");
  if (hermesBase?.uses !== REVIEWED_HERMES_PLATFORM_ACTION) {
    errors.push(`${JOB_ID} must use the shared reviewed Hermes platform resolver`);
  }
  requireValues(errors, `${JOB_ID} Hermes platform resolver`, record(hermesBase?.with), {
    "dockerfile-path": "agents/hermes/Dockerfile",
    platform: "${{ matrix.platform }}",
  });

  const trustedResolverCleanup = requireStep(
    errors,
    steps,
    "Remove trusted Hermes resolver checkout",
  );
  if (trustedResolverCleanup?.if !== "always()") {
    errors.push(`${JOB_ID} trusted Hermes resolver cleanup must always run`);
  }
  requireFragments(errors, trustedResolverCleanup, [
    `trusted_resolver_root="$GITHUB_WORKSPACE/${TRUSTED_HERMES_RESOLVER_ROOT}"`,
    '[[ -d "$trusted_resolver_root" && ! -L "$trusted_resolver_root" ]]',
    'rm -rf -- "$trusted_resolver_root"',
    '[[ ! -e "$trusted_resolver_root" && ! -L "$trusted_resolver_root" ]]',
  ]);

  const bases = requireStep(errors, steps, "Resolve exact platform base images");
  requireFragments(errors, bases, [
    'arch="${PLATFORM#linux/}"',
    'docker buildx imagetools inspect "$alias" --raw',
    '.platform.os == "linux" and .platform.architecture == $arch',
    'reference="${repository}@${digest}"',
    '"sha256:$(sha256sum "$exact_raw" | awk \'{print $1}\')" == "$digest"',
    "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
    "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest",
  ]);
  if (text(bases?.run).includes("ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest")) {
    errors.push(`${JOB_ID} must resolve Hermes from the immutable reviewed Dockerfile index`);
  }

  const registry = requireStep(errors, steps, "Start isolated protected managed-image registry");
  requireFragments(errors, registry, [
    'docker container inspect "$NEMOCLAW_PROTECTED_REGISTRY_NAME"',
    "http://127.0.0.1:5000/v2/",
    "io.nvidia.nemoclaw.e2e-owner=${NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT}",
    "--publish 127.0.0.1:5000:5000",
    REGISTRY_IMAGE,
  ]);

  const build = requireStep(errors, steps, "Build exact all-agent protected managed images");
  requireFragments(errors, build, [
    "scripts/checks/build-protected-managed-images.sh",
    '--revision "$CHECKOUT_SHA"',
    '--cohort "$NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT"',
    '--platform "$NEMOCLAW_PROTECTED_MANAGED_IMAGE_PLATFORM"',
    'cache_args=(--cache-to "$NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE")',
    '"${cache_args[@]}"',
    '--openclaw-base "$BASE_OPENCLAW"',
    '--hermes-base "$BASE_HERMES"',
    '--dcode-base "$BASE_DCODE"',
  ]);
  requireValues(errors, `${JOB_ID} protected build bases`, record(build?.env), {
    BASE_HERMES:
      "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${{ steps.hermes-base.outputs.digest }}",
  });

  const direct = requireStep(errors, steps, "Run every exact managed-image contract directly");
  requireFragments(errors, direct, [
    "scripts/checks/run-managed-image-direct-e2e.ts",
    "done < <(jq -c '.[]' \"$NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT\")",
    '--agent "$agent"',
    '--image "$reference"',
    '--platform "$platform"',
    'kind: "nemoclaw-protected-managed-image-multiarch-v1"',
    "headSha: $headSha",
    "baseSha: $baseSha",
    "workflowSha: $workflowSha",
    "platform: $platform",
    "cohort: $cohort",
    "contractSha256: $contractSha256",
    "contracts: $contracts[0]",
    "directRuns: $directRuns",
    "run: {id: $runId, attempt: $runAttempt}",
  ]);

  const cleanup = requireStep(errors, steps, "Remove isolated protected managed-image registry");
  if (cleanup?.if !== "always()") errors.push(`${JOB_ID} registry cleanup must always run`);
  requireFragments(errors, cleanup, [
    "io.nvidia.nemoclaw.e2e-owner",
    '[[ "$owner" == "$NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT" ]]',
    'docker rm -f "$NEMOCLAW_PROTECTED_REGISTRY_NAME"',
    "http://127.0.0.1:5000/v2/",
  ]);

  const evidence = requireStep(errors, steps, "Validate protected managed-image evidence");
  requireFragments(errors, evidence, [
    "tools/e2e/live-vitest-invocation.mts run",
    `--test-path ${DIRECT_TEST_PATH}`,
  ]);
  const cacheUpload = requireStep(
    errors,
    steps,
    "Publish exact amd64 protected runtime build cache",
  );
  if (cacheUpload?.if !== "${{ matrix.platform == 'linux/amd64' }}") {
    errors.push(`${JOB_ID} build cache publication must remain amd64-only`);
  }
  if (cacheUpload?.uses !== "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a") {
    errors.push(`${JOB_ID} must pin the reviewed build cache upload action`);
  }
  requireValues(errors, `${JOB_ID} build cache upload`, record(cacheUpload?.with), {
    name: "${{ env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE_ARTIFACT }}",
    path: "${{ env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE }}/",
    "if-no-files-found": "error",
    "retention-days": 1,
    "compression-level": 0,
    overwrite: true,
  });
  requireStep(errors, steps, "Upload protected managed-image evidence");
  requireStep(errors, steps, "Clean up Docker auth");
  requireOrderedSteps(errors, steps, [
    "Validate protected exact-head dispatch",
    "Checkout protected managed-image candidate source",
    "Validate trusted Hermes resolver checkout path",
    "Checkout trusted Hermes resolver",
    "Validate candidate activation contract",
    "Resolve reviewed Hermes platform base image",
    "Remove trusted Hermes resolver checkout",
    "Resolve exact platform base images",
    "Start isolated protected managed-image registry",
    "Build exact all-agent protected managed images",
    "Run every exact managed-image contract directly",
    "Remove isolated protected managed-image registry",
    "Validate protected managed-image evidence",
    "Publish exact amd64 protected runtime build cache",
    "Upload protected managed-image evidence",
    "Clean up Docker auth",
  ]);

  return errors;
}
