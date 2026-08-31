// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import YAML from "yaml";
import {
  OPENSHELL_DEV_ARTIFACT_DIRECTORY,
  OPENSHELL_DEV_ARTIFACT_UPLOAD_NAME,
  UPLOAD_E2E_ARTIFACTS_ACTION,
} from "./upload-e2e-artifacts-workflow-boundary.mts";
import {
  contentSha256,
  MCP_DEV_JOB_EXECUTION_CONTEXT_SHA256,
  MCP_DEV_POST_INSTALL_TRANSITION_CONTENT_SHA256,
  MCP_DEV_TRUSTED_NODE_SETUP_CONTENT_SHA256,
  MCP_DEV_TRUSTED_PREFIX_CONTENT_SHA256,
  MCP_DEV_WORKFLOW_EXECUTION_CONTEXT_SHA256,
} from "./mcp-dev-workflow-boundary-digests.mts";

const DEFAULT_WORKFLOW_PATH = ".github/workflows/e2e.yaml";
const MCP_JOBS = ["mcp-bridge", "mcp-bridge-dev"] as const;
const DEV_ARTIFACT_JOB = "openshell-dev-artifact";
const CREDENTIAL_WINDOW_JOB = "openshell-credential-generation-window";
const MCP_AGENT_SHARDS = ["openclaw", "hermes", "deepagents"] as const;
const MATRIX_AGENT_EXPRESSION = "${{ matrix.agent }}";
const TERMINAL_JOBS = [
  "release-qualification",
  "relevant-e2e",
  "report-to-pr",
  "scorecard",
] as const;
const DOCKER_CLEANUP_RUN = "bash .github/scripts/docker-auth-cleanup.sh";
const DEV_DOCKER_CLEANUP_NAME = "Revoke Docker auth before OpenShell development tooling";
const DEV_DOCKER_CLEANUP_RUN =
  'bash "${{ github.workspace }}/.trusted-openshell-dev-artifact/.github/scripts/docker-auth-cleanup.sh"';
const DEV_ARTIFACT_TOOL = "tools/e2e/openshell-dev-artifact.mts";
const DEV_ARTIFACT_JOB_CONDITION =
  "${{ contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'mcp-bridge-dev') }}";
const DEV_ARTIFACT_DOWNLOAD_ACTION =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const DEV_ARTIFACT_TRUSTED_CHECKOUT_NAME = "Checkout trusted OpenShell dev tooling";
const DEV_ARTIFACT_TRUSTED_CHECKOUT = ".trusted-openshell-dev-artifact";
const DEV_ARTIFACT_COPY_HELPER = ".github/scripts/copy-openshell-dev-asset.sh";
const DEV_ARTIFACT_TRUSTED_PATHS =
  "scripts/install-openshell.sh\ntools/e2e/openshell-dev-artifact.mts\n";
const DEV_ARTIFACT_SHARD_TRUSTED_PATHS = `${DEV_ARTIFACT_COPY_HELPER}\n.github/scripts/docker-auth-cleanup.sh\n${DEV_ARTIFACT_TRUSTED_PATHS}`;
const DEV_ARTIFACT_TRUSTED_TOOL = `\${{ github.workspace }}/${DEV_ARTIFACT_TRUSTED_CHECKOUT}/${DEV_ARTIFACT_TOOL}`;
const DEV_ARTIFACT_TRUSTED_COPY_HELPER = `\${{ github.workspace }}/${DEV_ARTIFACT_TRUSTED_CHECKOUT}/${DEV_ARTIFACT_COPY_HELPER}`;
const DEV_ARTIFACT_TRUSTED_INSTALLER = `\${{ github.workspace }}/${DEV_ARTIFACT_TRUSTED_CHECKOUT}/scripts/install-openshell.sh`;
const DEV_ARTIFACT_SOURCE_OUTPUT = "${{ needs.openshell-dev-artifact.outputs.source_commit }}";
const DEV_ARTIFACT_MANIFEST_OUTPUT = "${{ needs.openshell-dev-artifact.outputs.manifest_sha256 }}";
const DEV_ARTIFACT_ENV = {
  OPENSHELL_DEV_ARTIFACT_DIR: OPENSHELL_DEV_ARTIFACT_DIRECTORY,
  OPENSHELL_DEV_EXPECTED_MANIFEST_SHA256: DEV_ARTIFACT_MANIFEST_OUTPUT,
  OPENSHELL_DEV_EXPECTED_SOURCE_COMMIT: DEV_ARTIFACT_SOURCE_OUTPUT,
} as const;
const DEV_TRUSTED_NODE_SETUP_NAME = "Set up Node.js for trusted OpenShell verification";
const DEV_ARTIFACT_INSTALL_ASSETS = [
  "openshell-x86_64-unknown-linux-musl.tar.gz",
  "openshell-checksums-sha256.txt",
  "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz",
  "openshell-gateway-checksums-sha256.txt",
  "openshell-sandbox-x86_64-unknown-linux-musl.tar.gz",
  "openshell-sandbox-checksums-sha256.txt",
] as const;
const DEV_COMPATIBILITY_STEP_NAME = "Classify OpenShell credential-boundary compatibility";
const DEV_COMPATIBILITY_STEP_ID = "mcp_runtime_compatibility";
const DEV_COMPATIBILITY_TOOL = "tools/e2e/mcp-bridge-runtime-compatibility.mts";
const CREDENTIAL_WINDOW_ID = "openshell-credential-generation-window";
const CREDENTIAL_WINDOW_FILE = `test/e2e/live/${CREDENTIAL_WINDOW_ID}.test.ts`;
const CREDENTIAL_WINDOW_ARTIFACT_DIR = "e2e-artifacts/live/openshell-credential-generation-window";
const CREDENTIAL_WINDOW_RUN_STEP = "Run OpenShell credential generation-window live test";
const CREDENTIAL_WINDOW_JOB_CONDITION =
  "${{ contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'openshell-credential-generation-window') }}";
const STABLE_RELEASE_SUPERVISOR_INDEX =
  "722f44669722961b7f432b0b81de25b91a58f34a61d6403bef967acaf2b3af01";
const STABLE_MCP_INSTALL_CONTENT_SHA256 =
  "ea6b6f327b759097f0018478f2eef7bbd11eba3a88a3fbb631431f5a48c2611c";
const CREDENTIAL_WINDOW_INSTALL_CONTENT_SHA256 =
  "c2b5483a704eb73784dfc1c466cd13f584c0a91c7696d9723c2b7a9783a0e060";
const DEV_COMPATIBILITY_RUN = [
  "set -euo pipefail",
  'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"',
  `npx tsx ${DEV_COMPATIBILITY_TOOL}`,
  "",
].join("\n");
const DEV_FULL_LIFECYCLE_CONDITION =
  "${{ steps.mcp_runtime_compatibility.outputs.mode == 'full-lifecycle' }}";
const MCP_CLOUDFLARED_VERSION = "2026.6.1";
const MCP_CLOUDFLARED_DEB_SHA256 =
  "ccd02ec216c62bfa573395d8f72cb2e91e95cbdf8726a8acc06b3e2d9aa31526";
const LEGACY_WORKFLOWS = [
  ".github/workflows/e2e-script.yaml",
  ".github/workflows/e2e-vitest-scenarios.yaml",
  ".github/workflows/nightly-e2e.yaml",
] as const;
const FORBIDDEN_INFERENCE_SECRETS =
  /ANTHROPIC_API_KEY|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)|COMPATIBLE_(?:ANTHROPIC_)?API_KEY|GITHUB_TOKEN|GH_TOKEN|NVIDIA_(?:INFERENCE_)?API_KEY|OPENAI_API_KEY/;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asSteps(job: UnknownRecord): UnknownRecord[] {
  const steps = job.steps;
  return Array.isArray(steps) ? steps.map(asRecord) : [];
}

function namedStep(job: UnknownRecord, name: string): UnknownRecord {
  return asSteps(job).find((step) => step.name === name) ?? {};
}

function isArtifactUploadStep(step: UnknownRecord): boolean {
  const uses = asString(step.uses);
  return uses === UPLOAD_E2E_ARTIFACTS_ACTION || uses.startsWith("actions/upload-artifact@");
}

function jobNeeds(job: UnknownRecord): string[] {
  if (typeof job.needs === "string") return [job.needs];
  return Array.isArray(job.needs)
    ? job.needs.filter((item): item is string => typeof item === "string")
    : [];
}

function requireEqual(errors: string[], actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) errors.push(message);
}

function requireContains(
  errors: string[],
  actual: unknown,
  expected: string,
  message: string,
): void {
  if (!asString(actual).includes(expected)) errors.push(message);
}

function hasExactEntries(actual: UnknownRecord, expected: UnknownRecord): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => actual[key] === expected[key])
  );
}

function validateJobIdentity(
  errors: string[],
  jobName: (typeof MCP_JOBS)[number],
  job: UnknownRecord,
): void {
  const env = asRecord(job.env);
  const strategy = asRecord(job.strategy);
  const matrix = asRecord(strategy.matrix);
  requireEqual(errors, env.E2E_JOB, "1", `${jobName} must declare E2E_JOB=1`);
  requireEqual(
    errors,
    env.E2E_TARGET_ID,
    jobName,
    `${jobName} must use its job id as E2E_TARGET_ID`,
  );
  requireEqual(
    errors,
    env.E2E_MANAGED_IMAGE_REVISION,
    "${{ needs.base-image-publication.outputs.managed_image_revision }}",
    `${jobName} must receive the selected managed-image cohort revision`,
  );
  requireEqual(
    errors,
    env.E2E_MANAGED_IMAGE_COHORT_RECEIPT,
    "${{ needs.base-image-publication.outputs.managed_image_receipt }}",
    `${jobName} must receive the complete selected managed-image cohort receipt`,
  );
  requireEqual(
    errors,
    job["timeout-minutes"],
    90,
    `${jobName} must bound each shard to 90 minutes`,
  );
  requireEqual(errors, strategy["fail-fast"], false, `${jobName} shards must not fail fast`);
  requireEqual(
    errors,
    JSON.stringify(jobNeeds(job)),
    JSON.stringify(
      jobName === "mcp-bridge-dev"
        ? ["base-image-publication", "generate-matrix", DEV_ARTIFACT_JOB]
        : ["base-image-publication", "generate-matrix"],
    ),
    `${jobName} must depend on its reviewed artifact producers`,
  );
  if (JSON.stringify(matrix.agent) !== JSON.stringify(MCP_AGENT_SHARDS)) {
    errors.push(`${jobName} must exercise the reviewed OpenClaw, Hermes, and Deep Agents shards`);
  }
  requireEqual(
    errors,
    env.NEMOCLAW_MCP_BRIDGE_AGENT,
    MATRIX_AGENT_EXPRESSION,
    `${jobName} must select exactly its current MCP agent shard`,
  );
  requireEqual(
    errors,
    env.NEMOCLAW_E2E_SHARD,
    MATRIX_AGENT_EXPRESSION,
    `${jobName} must publish agent-scoped risk evidence`,
  );
  if (Object.hasOwn(env, "NEMOCLAW_MCP_BRIDGE_AGENT_MATRIX")) {
    errors.push(`${jobName} must not enable the retired in-process agent matrix`);
  }
  requireEqual(
    errors,
    env.NEMOCLAW_RUN_LIVE_E2E,
    "1",
    `${jobName} must enable the unified live E2E project`,
  );
  requireContains(
    errors,
    env.E2E_ARTIFACT_DIR,
    `e2e-artifacts/live/${jobName}/${MATRIX_AGENT_EXPRESSION}`,
    `${jobName} must isolate its artifact directory`,
  );
  if (jobName === "mcp-bridge") {
    requireEqual(
      errors,
      env.NEMOCLAW_OPENSHELL_CHANNEL,
      "stable",
      "mcp-bridge must pin the stable OpenShell channel",
    );
    requireEqual(
      errors,
      env.NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF,
      "1",
      "mcp-bridge must enable the exact stable release proof",
    );
    requireEqual(
      errors,
      env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE,
      `ghcr.io/nvidia/openshell/supervisor@sha256:${STABLE_RELEASE_SUPERVISOR_INDEX}`,
      "mcp-bridge must pin the reviewed stable supervisor image",
    );
    if (Object.hasOwn(env, "E2E_DEFAULT_ENABLED")) {
      errors.push("mcp-bridge must remain default-enabled");
    }
    requireEqual(
      errors,
      job.if,
      "${{ contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'mcp-bridge') }}",
      "mcp-bridge must use the trusted execution plan",
    );
  } else {
    if (Object.hasOwn(env, "E2E_DEFAULT_ENABLED")) {
      errors.push("mcp-bridge-dev must remain default-enabled");
    }
    requireEqual(
      errors,
      env.NEMOCLAW_OPENSHELL_CHANNEL,
      "dev",
      "mcp-bridge-dev must select the OpenShell dev channel",
    );
    if (Object.hasOwn(env, "NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL")) {
      errors.push("mcp-bridge-dev must not authorize moving unverified dev artifacts");
    }
    requireEqual(
      errors,
      job.if,
      "${{ contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'mcp-bridge-dev') }}",
      "mcp-bridge-dev must use the trusted execution plan",
    );
  }
}

function validateJobSecurity(
  errors: string[],
  jobName: string,
  job: UnknownRecord,
  canonicalDockerAuth: UnknownRecord,
): void {
  if (jobName === "mcp-bridge-dev") {
    const { steps: _jobSteps, ...jobExecutionContext } = job;
    if (contentSha256(jobExecutionContext) !== MCP_DEV_JOB_EXECUTION_CONTEXT_SHA256) {
      errors.push(
        "mcp-bridge-dev must preserve its reviewed job execution context before candidate activation",
      );
    }
  }
  const permissions = asRecord(job.permissions);
  if (Object.keys(permissions).sort().join(",") !== "contents" || permissions.contents !== "read") {
    errors.push(`${jobName} must use only contents:read permissions`);
  }

  const checkouts = asSteps(job).filter((step) =>
    asString(step.uses).startsWith("actions/checkout@"),
  );
  const expectedCheckoutCount = jobName === "mcp-bridge-dev" ? 2 : 1;
  if (checkouts.length !== expectedCheckoutCount) {
    errors.push(
      `${jobName} must use exactly ${expectedCheckoutCount === 1 ? "one checkout step" : "two checkout steps"}`,
    );
  }
  for (const checkout of checkouts) {
    if (!/^actions\/checkout@[0-9a-f]{40}$/.test(asString(checkout.uses))) {
      errors.push(`${jobName} must use a SHA-pinned checkout`);
    }
    if (asRecord(checkout.with)["persist-credentials"] !== false) {
      errors.push(`${jobName} checkout must set persist-credentials:false`);
    }
  }
  if (FORBIDDEN_INFERENCE_SECRETS.test(JSON.stringify(job))) {
    errors.push(`${jobName} must not receive inference or GitHub credentials`);
  }

  const login = namedStep(job, "Authenticate to Docker Hub");
  const cleanup = namedStep(job, "Clean up Docker auth");
  if (JSON.stringify(login) !== JSON.stringify(canonicalDockerAuth)) {
    errors.push(`${jobName} must reuse the canonical isolated Docker Hub auth step`);
  }
  const expectedCleanup = {
    name: "Clean up Docker auth",
    if: "always()",
    shell: "bash",
    run: DOCKER_CLEANUP_RUN,
  };
  if (JSON.stringify(cleanup) !== JSON.stringify(expectedCleanup)) {
    errors.push(`${jobName} must use the canonical unconditional Docker auth cleanup`);
  }
  const steps = asSteps(job);
  const checkoutIndex = steps.indexOf(checkouts[0] ?? {});
  const trustedNodeSetup = namedStep(job, DEV_TRUSTED_NODE_SETUP_NAME);
  const trustedNodeSetupIndex = steps.indexOf(trustedNodeSetup);
  if (
    jobName === "mcp-bridge-dev" &&
    (contentSha256(trustedNodeSetup) !== MCP_DEV_TRUSTED_NODE_SETUP_CONTENT_SHA256 ||
      trustedNodeSetupIndex !== checkoutIndex - 1)
  ) {
    errors.push(
      "mcp-bridge-dev must set up Node.js without dependency caching before candidate checkout",
    );
  }
  if (steps.indexOf(login) !== checkoutIndex + 1) {
    errors.push(`${jobName} must authenticate immediately after credential-free checkout`);
  }
  if (steps.indexOf(cleanup) !== steps.length - 1) {
    errors.push(`${jobName} Docker auth cleanup must remain the final step`);
  }
  if (jobName === "mcp-bridge-dev") {
    const trustedCheckout = namedStep(job, DEV_ARTIFACT_TRUSTED_CHECKOUT_NAME);
    if (
      !hasExactEntries(asRecord(trustedCheckout.with), {
        repository: "${{ github.repository }}",
        ref: "${{ inputs.workflow_sha || github.workflow_sha }}",
        path: DEV_ARTIFACT_TRUSTED_CHECKOUT,
        "persist-credentials": false,
        "sparse-checkout": DEV_ARTIFACT_SHARD_TRUSTED_PATHS,
      })
    ) {
      errors.push("mcp-bridge-dev must check out only the trusted OpenShell dev tooling");
    }
    const devCleanup = namedStep(job, DEV_DOCKER_CLEANUP_NAME);
    const install = namedStep(job, "Install immutable OpenShell dev artifact");
    const expectedDevCleanup = {
      name: DEV_DOCKER_CLEANUP_NAME,
      shell: "bash",
      run: DEV_DOCKER_CLEANUP_RUN,
    };
    if (JSON.stringify(devCleanup) !== JSON.stringify(expectedDevCleanup)) {
      errors.push("mcp-bridge-dev must revoke Docker auth before OpenShell development tooling");
    }
    const devCleanupIndex = steps.indexOf(devCleanup);
    const installIndex = steps.indexOf(install);
    if (devCleanupIndex <= steps.indexOf(login) || installIndex <= devCleanupIndex) {
      errors.push(
        "mcp-bridge-dev Docker auth revocation must follow setup and precede development artifact installation",
      );
    }
    if (
      devCleanupIndex >= 0 &&
      steps.slice(devCleanupIndex + 1).some((step) => step.name === "Authenticate to Docker Hub")
    ) {
      errors.push("mcp-bridge-dev must not restore Docker auth after dev-tooling revocation");
    }
  }
}

function validateJobExecution(
  errors: string[],
  jobName: (typeof MCP_JOBS)[number],
  job: UnknownRecord,
): void {
  const steps = asSteps(job);
  const cloudflared = namedStep(job, "Install and verify cloudflared prerequisite");
  const tls = namedStep(job, "Generate MCP test TLS");
  const install = namedStep(
    job,
    jobName === "mcp-bridge-dev"
      ? "Install immutable OpenShell dev artifact"
      : "Install OpenShell CLI",
  );
  const run = namedStep(job, "Run MCP OpenShell provider live test");
  const compatibility = namedStep(job, DEV_COMPATIBILITY_STEP_NAME);
  const compatibilitySteps = steps.filter((step) =>
    asString(step.run).includes(DEV_COMPATIBILITY_TOOL),
  );
  const scan = namedStep(job, "Scan MCP artifacts for fixture credentials");
  const uploads = steps.filter(isArtifactUploadStep);
  const upload = namedStep(job, "Upload MCP server artifacts");
  if (uploads.length !== 1 || uploads[0] !== upload) {
    errors.push(`${jobName} must use exactly one reviewed MCP artifact upload step`);
  }

  const cloudflaredEnv = asRecord(cloudflared.env);
  requireEqual(
    errors,
    cloudflaredEnv.CLOUDFLARED_VERSION,
    MCP_CLOUDFLARED_VERSION,
    `${jobName} must pin cloudflared ${MCP_CLOUDFLARED_VERSION}`,
  );
  requireEqual(
    errors,
    cloudflaredEnv.CLOUDFLARED_DEB_SHA256,
    MCP_CLOUDFLARED_DEB_SHA256,
    `${jobName} must pin the reviewed cloudflared package checksum`,
  );
  for (const required of [
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb",
    "sha256sum -c -",
    "dpkg-deb -f",
    "sudo dpkg -i",
    "cloudflared version ${CLOUDFLARED_VERSION}",
  ]) {
    requireContains(
      errors,
      cloudflared.run,
      required,
      `${jobName} cloudflared installation is not immutable and verified`,
    );
  }
  for (const forbidden of ["pkg.cloudflare.com", "apt-get install", "apt install"]) {
    if (asString(cloudflared.run).includes(forbidden)) {
      errors.push(`${jobName} cloudflared installation must not use mutable package repositories`);
    }
  }
  if (steps.indexOf(cloudflared) < 0 || steps.indexOf(tls) <= steps.indexOf(cloudflared)) {
    errors.push(`${jobName} must install verified cloudflared before creating MCP fixtures`);
  }

  requireEqual(
    errors,
    tls.run,
    "bash test/e2e/setup-mcp-test-tls.sh",
    `${jobName} must use the reviewed HTTPS fixture generator`,
  );
  if (jobName === "mcp-bridge-dev") {
    if (steps.indexOf(install) < 0 || steps.indexOf(cloudflared) <= steps.indexOf(install)) {
      errors.push(
        "mcp-bridge-dev must install the trusted OpenShell artifact before candidate fixture preparation",
      );
    }
  } else if (steps.indexOf(tls) < 0 || steps.indexOf(install) <= steps.indexOf(tls)) {
    errors.push("mcp-bridge must generate HTTPS fixtures before installing OpenShell");
  }
  const installEnv = asRecord(install.env);
  if (jobName === "mcp-bridge-dev") {
    if (
      !hasExactEntries(installEnv, {
        NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
        NEMOCLAW_OPENSHELL_FORCE_INSTALL: "1",
        OPENSHELL_DEV_ASSET_DIR: `${OPENSHELL_DEV_ARTIFACT_DIRECTORY}/assets`,
      })
    ) {
      errors.push(
        "mcp-bridge-dev installer must receive only the retained OpenShell asset directory",
      );
    }
  } else {
    requireEqual(
      errors,
      installEnv.NEMOCLAW_OPENSHELL_FORCE_INSTALL,
      "1",
      `${jobName} must force the selected OpenShell install`,
    );
    if (Object.hasOwn(installEnv, "NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL")) {
      errors.push("mcp-bridge stable installer must not authorize unverified dev artifacts");
    }
    requireEqual(
      errors,
      contentSha256(asString(install.run)),
      STABLE_MCP_INSTALL_CONTENT_SHA256,
      `${jobName} stable installer command block must match the reviewed release installation and provenance sequence`,
    );
  }
  if (jobName === "mcp-bridge-dev") {
    const trustedCheckout = namedStep(job, DEV_ARTIFACT_TRUSTED_CHECKOUT_NAME);
    const restoreCli = namedStep(job, "Restore exact-commit CLI artifact");
    const restoreArtifact = namedStep(job, "Restore immutable OpenShell dev artifact");
    const verifyArtifact = namedStep(job, "Verify immutable OpenShell dev artifact");
    requireEqual(
      errors,
      restoreArtifact.uses,
      DEV_ARTIFACT_DOWNLOAD_ACTION,
      "mcp-bridge-dev must use the reviewed immutable artifact downloader",
    );
    if (
      !hasExactEntries(asRecord(restoreArtifact.with), {
        name: "${{ needs.openshell-dev-artifact.outputs.artifact_name }}",
        path: OPENSHELL_DEV_ARTIFACT_DIRECTORY,
        "digest-mismatch": "error",
      })
    ) {
      errors.push("mcp-bridge-dev must restore exactly the resolver's content-addressed artifact");
    }
    if (!hasExactEntries(asRecord(verifyArtifact.env), DEV_ARTIFACT_ENV)) {
      errors.push(
        "mcp-bridge-dev artifact verification must receive only its reviewed artifact identity",
      );
    }
    for (const token of [
      `"${DEV_ARTIFACT_TRUSTED_TOOL}"`,
      " verify ",
      '"$OPENSHELL_DEV_ARTIFACT_DIR"',
      '"$OPENSHELL_DEV_EXPECTED_SOURCE_COMMIT"',
      '"$OPENSHELL_DEV_EXPECTED_MANIFEST_SHA256"',
    ]) {
      requireContains(
        errors,
        verifyArtifact.run,
        token,
        "mcp-bridge-dev must verify the immutable OpenShell artifact before installation",
      );
    }
    for (const token of [
      ...DEV_ARTIFACT_INSTALL_ASSETS,
      'cat >"$shim_dir/gh"',
      `bash "${DEV_ARTIFACT_TRUSTED_COPY_HELPER}"`,
      '"$OPENSHELL_DEV_ASSET_DIR" "$asset" "$destination"',
      'cat >"$shim_dir/curl"',
      "Network fallback is disabled for retained OpenShell assets.",
      'PATH="$shim_dir:$PATH"',
      `bash "${DEV_ARTIFACT_TRUSTED_INSTALLER}"`,
    ]) {
      requireContains(
        errors,
        install.run,
        token,
        "mcp-bridge-dev must install retained assets through the trusted no-network release path",
      );
    }
    if (asString(install.run).includes("tools/e2e/openshell-dev-artifact.mts prepare")) {
      errors.push("mcp-bridge-dev must not maintain a second OpenShell installer");
    }
    const devCleanup = namedStep(job, DEV_DOCKER_CLEANUP_NAME);
    const dockerAuth = namedStep(job, "Authenticate to Docker Hub");
    const prepare = namedStep(job, "Prepare E2E workspace");
    const trustedNodeSetup = namedStep(job, DEV_TRUSTED_NODE_SETUP_NAME);
    const trustedNodeSetupIndex = steps.indexOf(trustedNodeSetup);
    const dockerAuthIndex = steps.indexOf(dockerAuth);
    const prepareIndex = steps.indexOf(prepare);
    const trustedCheckoutIndex = steps.indexOf(trustedCheckout);
    const installIndex = steps.indexOf(install);
    const restoreCliIndex = steps.indexOf(restoreCli);
    const trustedInstallSequence = [
      trustedCheckout,
      restoreArtifact,
      verifyArtifact,
      devCleanup,
      install,
    ];
    if (
      dockerAuthIndex !== trustedNodeSetupIndex + 2 ||
      trustedCheckoutIndex !== dockerAuthIndex + 1 ||
      prepareIndex !== installIndex + 1 ||
      restoreCliIndex !== prepareIndex + 1 ||
      trustedInstallSequence.some((step, offset) => steps[trustedCheckoutIndex + offset] !== step)
    ) {
      errors.push(
        "mcp-bridge-dev must complete trusted Node.js setup, Docker auth, artifact verification, credential revocation, and installation before candidate dependency preparation and CLI restore",
      );
    }
    if (
      installIndex < 0 ||
      contentSha256(steps.slice(0, installIndex + 1)) !== MCP_DEV_TRUSTED_PREFIX_CONTENT_SHA256
    ) {
      errors.push("mcp-bridge-dev must preserve every reviewed step through trusted installation");
    }
    if (
      prepareIndex < 0 ||
      restoreCliIndex < prepareIndex ||
      contentSha256(steps.slice(prepareIndex, restoreCliIndex + 1)) !==
        MCP_DEV_POST_INSTALL_TRANSITION_CONTENT_SHA256
    ) {
      errors.push(
        "mcp-bridge-dev must preserve reviewed dependency preparation and candidate CLI restore after trusted installation",
      );
    }
    if (compatibilitySteps.length !== 1 || compatibilitySteps[0] !== compatibility) {
      errors.push("mcp-bridge-dev must use exactly one canonical runtime compatibility classifier");
    }
    const expectedCompatibility = {
      id: DEV_COMPATIBILITY_STEP_ID,
      name: DEV_COMPATIBILITY_STEP_NAME,
      run: DEV_COMPATIBILITY_RUN,
    };
    if (!hasExactEntries(compatibility, expectedCompatibility)) {
      errors.push(
        "mcp-bridge-dev must use the canonical unconditional runtime compatibility classifier",
      );
    }
    requireEqual(
      errors,
      compatibility.id,
      DEV_COMPATIBILITY_STEP_ID,
      "mcp-bridge-dev runtime compatibility classifier must expose its canonical step id",
    );
    requireContains(
      errors,
      compatibility.run,
      `npx tsx ${DEV_COMPATIBILITY_TOOL}`,
      "mcp-bridge-dev runtime compatibility classifier must use the reviewed tool",
    );
    requireEqual(
      errors,
      run.if,
      DEV_FULL_LIFECYCLE_CONDITION,
      "mcp-bridge-dev must run the full MCP lifecycle only for an aligned runtime",
    );
    if (
      steps.indexOf(install) < 0 ||
      steps.indexOf(compatibility) <= steps.indexOf(install) ||
      steps.indexOf(run) <= steps.indexOf(compatibility)
    ) {
      errors.push(
        "mcp-bridge-dev must classify the installed runtime before the full MCP lifecycle",
      );
    }
  } else {
    if (compatibilitySteps.length > 0 || Object.keys(compatibility).length > 0) {
      errors.push("mcp-bridge stable lane must not use dev runtime compatibility branching");
    }
    if (Object.hasOwn(run, "if")) {
      errors.push("mcp-bridge stable lane must run its full MCP lifecycle unconditionally");
    }
  }
  for (const required of [
    "tools/e2e/live-vitest-invocation.mts run --test-path",
    "test/e2e/live/mcp-bridge.test.ts",
  ]) {
    requireContains(errors, run.run, required, `${jobName} must run the unified MCP live test`);
  }
  requireContains(
    errors,
    run.run,
    "tools/e2e/live-vitest-invocation.mts run --test-path",
    `${jobName} must publish canonical risk-signal evidence`,
  );
  if (jobName === "mcp-bridge") {
    if (asString(run.run).includes(CREDENTIAL_WINDOW_FILE)) {
      errors.push(
        "mcp-bridge must not serialize the independent credential generation-window proof",
      );
    }
  }
  requireEqual(
    errors,
    scan.id,
    "mcp_artifact_secret_scan",
    `${jobName} secret scanner must expose its gated step id`,
  );
  requireEqual(
    errors,
    scan.if,
    "always()",
    `${jobName} artifact secret scan must run unconditionally`,
  );
  for (const required of [
    "tools/e2e/assert-mcp-artifact-secrets-absent.mts",
    `e2e-artifacts/live/${jobName}/${MATRIX_AGENT_EXPRESSION}`,
  ]) {
    requireContains(errors, scan.run, required, `${jobName} artifact secret scan is incomplete`);
  }
  requireEqual(
    errors,
    upload.uses,
    UPLOAD_E2E_ARTIFACTS_ACTION,
    `${jobName} artifact upload must use the reviewed shared uploader`,
  );
  requireEqual(
    errors,
    upload.if,
    "${{ always() && steps.mcp_artifact_secret_scan.outcome == 'success' }}",
    `${jobName} artifact upload must be gated by the secret scanner`,
  );
  const uploadOptions = asRecord(upload.with);
  requireEqual(
    errors,
    uploadOptions.path,
    `e2e-artifacts/live/${jobName}/${MATRIX_AGENT_EXPRESSION}/`,
    `${jobName} artifact upload must use exactly the scanned directory`,
  );
  requireEqual(
    errors,
    uploadOptions.name,
    `e2e-${jobName}-${MATRIX_AGENT_EXPRESSION}`,
    `${jobName} artifact upload must use its isolated artifact name`,
  );
  if (Object.keys(uploadOptions).sort().join(",") !== "name,path") {
    errors.push(`${jobName} artifact upload must delegate policy to the reviewed shared uploader`);
  }
  if (steps.indexOf(scan) < 0 || steps.indexOf(upload) <= steps.indexOf(scan)) {
    errors.push(`${jobName} must scan artifacts before upload`);
  }
  if (steps.indexOf(run) < 0 || steps.indexOf(scan) <= steps.indexOf(run)) {
    errors.push(`${jobName} must scan artifacts after its MCP compatibility execution`);
  }
}

function validateDevArtifactJob(errors: string[], job: UnknownRecord): void {
  if (Object.keys(job).length === 0) {
    errors.push(`missing OpenShell development artifact job: ${DEV_ARTIFACT_JOB}`);
    return;
  }
  requireEqual(
    errors,
    JSON.stringify(jobNeeds(job)),
    JSON.stringify(["generate-matrix"]),
    `${DEV_ARTIFACT_JOB} must depend only on matrix generation`,
  );
  requireEqual(
    errors,
    job.if,
    DEV_ARTIFACT_JOB_CONDITION,
    `${DEV_ARTIFACT_JOB} must use the trusted execution plan`,
  );
  requireEqual(
    errors,
    job["runs-on"],
    "ubuntu-latest",
    `${DEV_ARTIFACT_JOB} must use an ephemeral standard runner`,
  );
  requireEqual(
    errors,
    job["timeout-minutes"],
    15,
    `${DEV_ARTIFACT_JOB} must retain its bounded 15-minute budget`,
  );
  if (!hasExactEntries(asRecord(job.permissions), { contents: "read" })) {
    errors.push(`${DEV_ARTIFACT_JOB} must use only contents:read permissions`);
  }
  if (
    !hasExactEntries(asRecord(job.outputs), {
      artifact_name: "${{ steps.resolve_openshell_dev_artifact.outputs.artifact_name }}",
      source_commit: "${{ steps.resolve_openshell_dev_artifact.outputs.source_commit }}",
      manifest_sha256: "${{ steps.resolve_openshell_dev_artifact.outputs.manifest_sha256 }}",
    })
  ) {
    errors.push(`${DEV_ARTIFACT_JOB} must expose only the immutable artifact identity`);
  }
  if (FORBIDDEN_INFERENCE_SECRETS.test(JSON.stringify(job))) {
    errors.push(`${DEV_ARTIFACT_JOB} must not receive inference or GitHub credentials`);
  }

  const steps = asSteps(job);
  const checkouts = steps.filter((step) => asString(step.uses).startsWith("actions/checkout@"));
  if (checkouts.length !== 1) errors.push(`${DEV_ARTIFACT_JOB} must use exactly one checkout`);
  const checkout = checkouts[0] ?? {};
  if (!/^actions\/checkout@[a-f0-9]{40}$/u.test(asString(checkout.uses))) {
    errors.push(`${DEV_ARTIFACT_JOB} must use a SHA-pinned checkout`);
  }
  if (
    !hasExactEntries(asRecord(checkout.with), {
      repository: "${{ github.repository }}",
      ref: "${{ inputs.workflow_sha || github.workflow_sha }}",
      path: DEV_ARTIFACT_TRUSTED_CHECKOUT,
      "persist-credentials": false,
      "sparse-checkout": DEV_ARTIFACT_TRUSTED_PATHS,
    })
  ) {
    errors.push(`${DEV_ARTIFACT_JOB} must check out only the trusted workflow revision`);
  }
  const setup = namedStep(job, "Set up Node for OpenShell dev artifact resolution");
  if (!/^actions\/setup-node@[a-f0-9]{40}$/u.test(asString(setup.uses))) {
    errors.push(`${DEV_ARTIFACT_JOB} must use a SHA-pinned Node setup`);
  }
  if (!hasExactEntries(asRecord(setup.with), { "node-version": 22 })) {
    errors.push(`${DEV_ARTIFACT_JOB} must use only the reviewed Node version`);
  }
  const resolve = namedStep(job, "Resolve immutable OpenShell dev artifact");
  requireEqual(
    errors,
    resolve.id,
    "resolve_openshell_dev_artifact",
    `${DEV_ARTIFACT_JOB} resolver must expose its canonical step id`,
  );
  for (const token of [
    `"${DEV_ARTIFACT_TRUSTED_TOOL}"`,
    " resolve ",
    OPENSHELL_DEV_ARTIFACT_DIRECTORY,
  ]) {
    requireContains(
      errors,
      resolve.run,
      token,
      `${DEV_ARTIFACT_JOB} must run the trusted immutable resolver`,
    );
  }
  const upload = namedStep(job, "Upload OpenShell dev artifact resolution");
  requireEqual(
    errors,
    upload.uses,
    UPLOAD_E2E_ARTIFACTS_ACTION,
    `${DEV_ARTIFACT_JOB} must use the reviewed shared uploader`,
  );
  requireEqual(
    errors,
    upload.if,
    "${{ always() }}",
    `${DEV_ARTIFACT_JOB} must retain infrastructure diagnostics on failure`,
  );
  if (
    !hasExactEntries(asRecord(upload.with), {
      name: OPENSHELL_DEV_ARTIFACT_UPLOAD_NAME,
      path: `${OPENSHELL_DEV_ARTIFACT_DIRECTORY}/`,
    })
  ) {
    errors.push(`${DEV_ARTIFACT_JOB} must retain its content-addressed 14-day artifact contract`);
  }
  if (
    steps.indexOf(checkout) !== 0 ||
    steps.indexOf(setup) <= steps.indexOf(checkout) ||
    steps.indexOf(resolve) <= steps.indexOf(setup) ||
    steps.indexOf(upload) !== steps.length - 1
  ) {
    errors.push(`${DEV_ARTIFACT_JOB} must resolve before its final diagnostic-preserving upload`);
  }
}

function validateCredentialWindowJob(
  errors: string[],
  job: UnknownRecord,
  canonicalDockerAuth: UnknownRecord,
): void {
  if (Object.keys(job).length === 0) {
    errors.push(`missing independent MCP job: ${CREDENTIAL_WINDOW_JOB}`);
    return;
  }

  requireEqual(
    errors,
    JSON.stringify(jobNeeds(job)),
    JSON.stringify(["base-image-publication", "generate-matrix"]),
    `${CREDENTIAL_WINDOW_JOB} must depend on publication and matrix generation`,
  );
  requireEqual(
    errors,
    job["runs-on"],
    "ubuntu-latest",
    `${CREDENTIAL_WINDOW_JOB} must use its independent standard runner`,
  );
  requireEqual(
    errors,
    job["timeout-minutes"],
    90,
    `${CREDENTIAL_WINDOW_JOB} must retain its bounded 90-minute budget`,
  );
  requireEqual(
    errors,
    job.if,
    CREDENTIAL_WINDOW_JOB_CONDITION,
    `${CREDENTIAL_WINDOW_JOB} must use the trusted execution plan`,
  );

  const env = asRecord(job.env);
  const expectedEnv = {
    E2E_MANAGED_IMAGE_REVISION:
      "${{ needs.base-image-publication.outputs.managed_image_revision }}",
    E2E_MANAGED_IMAGE_COHORT_RECEIPT:
      "${{ needs.base-image-publication.outputs.managed_image_receipt }}",
    E2E_WORKLOAD_SOURCE: "${{ needs.generate-matrix.outputs.workload_source }}",
    E2E_JOB: "1",
    E2E_TARGET_ID: CREDENTIAL_WINDOW_JOB,
    E2E_AGENT_RUNTIME: "openclaw",
    E2E_OBSERVABLE_OUTCOME:
      "Credential expiry rotation detach and rebuild preserve the intended access window",
    E2E_ENVIRONMENT_OR_INFERENCE_ENDPOINT:
      "Ubuntu Docker host; local compatible inference and MCP endpoint",
    E2E_ARTIFACT_DIR: `\${{ github.workspace }}/${CREDENTIAL_WINDOW_ARTIFACT_DIR}`,
    NEMOCLAW_CLI_BIN: "${{ github.workspace }}/bin/nemoclaw.js",
    NEMOCLAW_OPENSHELL_CHANNEL: "stable",
    NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF: "1",
    NEMOCLAW_RUN_LIVE_E2E: "1",
    OPENSHELL_DOCKER_SUPERVISOR_IMAGE: `ghcr.io/nvidia/openshell/supervisor@sha256:${STABLE_RELEASE_SUPERVISOR_INDEX}`,
  };
  if (!hasExactEntries(env, expectedEnv)) {
    errors.push(`${CREDENTIAL_WINDOW_JOB} must use only its reviewed exact-stable environment`);
  }
  validateJobSecurity(errors, CREDENTIAL_WINDOW_JOB, job, canonicalDockerAuth);

  const steps = asSteps(job);
  const prepare = namedStep(job, "Prepare E2E workspace");
  const cloudflared = namedStep(job, "Install and verify cloudflared prerequisite");
  const tls = namedStep(job, "Generate MCP test TLS");
  const install = namedStep(job, "Install OpenShell CLI");
  const run = namedStep(job, CREDENTIAL_WINDOW_RUN_STEP);
  const scan = namedStep(job, "Scan credential-window artifacts for fixture credentials");
  const upload = namedStep(job, "Upload credential-window artifacts");

  if (
    !/^NVIDIA\/NemoClaw\/\.github\/actions\/prepare-e2e@[0-9a-f]{40}$/u.test(asString(prepare.uses))
  ) {
    errors.push(`${CREDENTIAL_WINDOW_JOB} must use a SHA-pinned E2E workspace action`);
  }
  requireEqual(
    errors,
    asRecord(cloudflared.env).CLOUDFLARED_VERSION,
    MCP_CLOUDFLARED_VERSION,
    `${CREDENTIAL_WINDOW_JOB} must pin cloudflared ${MCP_CLOUDFLARED_VERSION}`,
  );
  requireEqual(
    errors,
    asRecord(cloudflared.env).CLOUDFLARED_DEB_SHA256,
    MCP_CLOUDFLARED_DEB_SHA256,
    `${CREDENTIAL_WINDOW_JOB} must pin the reviewed cloudflared package checksum`,
  );
  for (const required of [
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb",
    "sha256sum -c -",
    "dpkg-deb -f",
    "sudo dpkg -i",
    "cloudflared version ${CLOUDFLARED_VERSION}",
  ]) {
    requireContains(
      errors,
      cloudflared.run,
      required,
      `${CREDENTIAL_WINDOW_JOB} cloudflared installation is not immutable and verified`,
    );
  }
  for (const forbidden of ["pkg.cloudflare.com", "apt-get install", "apt install"]) {
    if (asString(cloudflared.run).includes(forbidden)) {
      errors.push(
        `${CREDENTIAL_WINDOW_JOB} cloudflared installation must not use mutable package repositories`,
      );
    }
  }
  requireEqual(
    errors,
    tls.run,
    "bash test/e2e/setup-mcp-test-tls.sh",
    `${CREDENTIAL_WINDOW_JOB} must generate its HTTPS fixture before installation`,
  );
  requireEqual(
    errors,
    asRecord(install.env).NEMOCLAW_OPENSHELL_FORCE_INSTALL,
    "1",
    `${CREDENTIAL_WINDOW_JOB} must force the stable OpenShell install`,
  );
  requireEqual(
    errors,
    contentSha256(asString(install.run)),
    CREDENTIAL_WINDOW_INSTALL_CONTENT_SHA256,
    `${CREDENTIAL_WINDOW_JOB} installer command block must match the reviewed release installation and provenance sequence`,
  );

  for (const required of [
    CREDENTIAL_WINDOW_FILE,
    `-t '^${CREDENTIAL_WINDOW_ID}$'`,
    "--no-file-parallelism",
    "--reporter=test/e2e/risk-signal-reporter.ts",
  ]) {
    requireContains(
      errors,
      run.run,
      required,
      `${CREDENTIAL_WINDOW_JOB} must run its exact isolated live proof`,
    );
  }
  const riskReporter = "--reporter=test/e2e/risk-signal-reporter.ts";
  if (asString(run.run).split(riskReporter).length - 1 !== 1) {
    errors.push(`${CREDENTIAL_WINDOW_JOB} must publish one canonical risk-signal stream`);
  }

  requireEqual(
    errors,
    scan.id,
    "credential_window_artifact_secret_scan",
    `${CREDENTIAL_WINDOW_JOB} secret scanner must expose its gated step id`,
  );
  requireEqual(
    errors,
    scan.if,
    "always()",
    `${CREDENTIAL_WINDOW_JOB} artifact secret scan must run unconditionally`,
  );
  for (const required of [
    "tools/e2e/assert-mcp-artifact-secrets-absent.mts",
    CREDENTIAL_WINDOW_ARTIFACT_DIR,
  ]) {
    requireContains(
      errors,
      scan.run,
      required,
      `${CREDENTIAL_WINDOW_JOB} artifact secret scan is incomplete`,
    );
  }
  requireEqual(
    errors,
    upload.uses,
    UPLOAD_E2E_ARTIFACTS_ACTION,
    `${CREDENTIAL_WINDOW_JOB} artifact upload must use the reviewed shared uploader`,
  );
  requireEqual(
    errors,
    upload.if,
    "${{ always() && steps.credential_window_artifact_secret_scan.outcome == 'success' }}",
    `${CREDENTIAL_WINDOW_JOB} artifact upload must be gated by the secret scanner`,
  );
  const uploadOptions = asRecord(upload.with);
  if (
    !hasExactEntries(uploadOptions, {
      name: `e2e-${CREDENTIAL_WINDOW_JOB}`,
      path: `${CREDENTIAL_WINDOW_ARTIFACT_DIR}/`,
    })
  ) {
    errors.push(`${CREDENTIAL_WINDOW_JOB} upload must use exactly its scanned artifact directory`);
  }

  const orderedSteps = [prepare, cloudflared, tls, install, run, scan, upload];
  if (
    orderedSteps.some((step) => steps.indexOf(step) < 0) ||
    orderedSteps.some(
      (step, index) => index > 0 && steps.indexOf(step) <= steps.indexOf(orderedSteps[index - 1]!),
    )
  ) {
    errors.push(`${CREDENTIAL_WINDOW_JOB} must preserve its reviewed execution and scan order`);
  }
}

export function validateMcpOpenShellWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  const errors: string[] = [];
  const workflowText = fs.readFileSync(workflowPath, "utf8");
  const workflow = asRecord(YAML.parse(workflowText));
  const jobs = asRecord(workflow.jobs);
  const canonicalDockerAuth = namedStep(asRecord(jobs.live), "Authenticate to Docker Hub");
  const inputs = asRecord(asRecord(asRecord(workflow.on).workflow_dispatch).inputs);
  const globalEnv = asRecord(workflow.env);

  if (
    contentSha256({ env: workflow.env, defaults: workflow.defaults }) !==
    MCP_DEV_WORKFLOW_EXECUTION_CONTEXT_SHA256
  ) {
    errors.push(
      "workflow must preserve the reviewed execution environment before candidate activation",
    );
  }

  if (Object.hasOwn(inputs, "openshell_channel")) {
    errors.push("the unified workflow must not expose a fan-out-wide OpenShell channel input");
  }
  if (Object.hasOwn(globalEnv, "NEMOCLAW_OPENSHELL_CHANNEL")) {
    errors.push("the unified workflow must select OpenShell channels only inside MCP jobs");
  }
  for (const legacy of LEGACY_WORKFLOWS) {
    if (workflowPath === DEFAULT_WORKFLOW_PATH && fs.existsSync(legacy)) {
      errors.push(`retired workflow must remain deleted: ${legacy}`);
    }
  }
  for (const retiredToken of [
    "test/e2e-scenario/",
    "tools/e2e-scenarios/",
    "e2e-scenarios-live",
    "NEMOCLAW_RUN_E2E_SCENARIOS",
    "e2e-artifacts/vitest/",
  ]) {
    if (workflowText.includes(retiredToken)) {
      errors.push(`unified MCP workflow must not reference retired token: ${retiredToken}`);
    }
  }

  for (const jobName of MCP_JOBS) {
    const job = asRecord(jobs[jobName]);
    if (Object.keys(job).length === 0) {
      errors.push(`missing unified MCP job: ${jobName}`);
      continue;
    }
    validateJobIdentity(errors, jobName, job);
    validateJobSecurity(errors, jobName, job, canonicalDockerAuth);
    validateJobExecution(errors, jobName, job);
  }
  validateDevArtifactJob(errors, asRecord(jobs[DEV_ARTIFACT_JOB]));
  validateCredentialWindowJob(errors, asRecord(jobs[CREDENTIAL_WINDOW_JOB]), canonicalDockerAuth);

  for (const terminalJobName of TERMINAL_JOBS) {
    const terminal = asRecord(jobs[terminalJobName]);
    const terminalNeeds = new Set(jobNeeds(terminal));
    for (const mcpJob of [...MCP_JOBS, DEV_ARTIFACT_JOB, CREDENTIAL_WINDOW_JOB]) {
      if (!terminalNeeds.has(mcpJob)) {
        errors.push(`${terminalJobName} must wait for ${mcpJob}`);
      }
    }
  }

  return errors;
}
