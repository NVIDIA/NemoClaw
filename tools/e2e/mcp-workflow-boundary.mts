// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import YAML from "yaml";
import { UPLOAD_E2E_ARTIFACTS_ACTION } from "./upload-e2e-artifacts-workflow-boundary.mts";

const DEFAULT_WORKFLOW_PATH = ".github/workflows/e2e.yaml";
const MCP_JOBS = ["mcp-bridge", "mcp-bridge-dev"] as const;
const TERMINAL_JOBS = ["report-to-pr", "scorecard"] as const;
const DOCKER_CLEANUP_RUN = "bash .github/scripts/docker-auth-cleanup.sh";
const DEV_DOCKER_CLEANUP_NAME = "Revoke Docker auth before unverified dev tooling";
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

function validateJobIdentity(
  errors: string[],
  jobName: (typeof MCP_JOBS)[number],
  job: UnknownRecord,
): void {
  const env = asRecord(job.env);
  requireEqual(errors, env.E2E_JOB, "1", `${jobName} must declare E2E_JOB=1`);
  requireEqual(
    errors,
    env.E2E_TARGET_ID,
    jobName,
    `${jobName} must use its job id as E2E_TARGET_ID`,
  );
  requireEqual(
    errors,
    env.NEMOCLAW_MCP_BRIDGE_AGENT_MATRIX,
    "1",
    `${jobName} must exercise all three MCP adapters`,
  );
  requireEqual(
    errors,
    env.NEMOCLAW_RUN_LIVE_E2E,
    "1",
    `${jobName} must enable the unified live E2E project`,
  );
  requireContains(
    errors,
    env.E2E_ARTIFACT_DIR,
    `e2e-artifacts/live/${jobName}`,
    `${jobName} must isolate its artifact directory`,
  );
  if (jobName === "mcp-bridge") {
    requireEqual(
      errors,
      env.NEMOCLAW_OPENSHELL_CHANNEL,
      "stable",
      "mcp-bridge must pin the stable OpenShell channel",
    );
    if (Object.hasOwn(env, "E2E_DEFAULT_ENABLED")) {
      errors.push("mcp-bridge must remain default-enabled");
    }
    requireContains(
      errors,
      job.if,
      "inputs.jobs == ''",
      "mcp-bridge must run in default full-suite dispatches",
    );
  } else {
    requireEqual(errors, env.E2E_DEFAULT_ENABLED, "0", "mcp-bridge-dev must remain explicit-only");
    requireEqual(
      errors,
      env.NEMOCLAW_OPENSHELL_CHANNEL,
      "dev",
      "mcp-bridge-dev must select the OpenShell dev channel",
    );
    if (Object.hasOwn(env, "NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL")) {
      errors.push("mcp-bridge-dev must scope unverified artifact opt-in to its installer step");
    }
    if (asString(job.if).includes("inputs.jobs == ''")) {
      errors.push("mcp-bridge-dev must not run in default full-suite dispatches");
    }
  }
}

function validateJobSecurity(
  errors: string[],
  jobName: (typeof MCP_JOBS)[number],
  job: UnknownRecord,
  canonicalDockerAuth: UnknownRecord,
): void {
  const permissions = asRecord(job.permissions);
  if (Object.keys(permissions).sort().join(",") !== "contents" || permissions.contents !== "read") {
    errors.push(`${jobName} must use only contents:read permissions`);
  }

  const checkouts = asSteps(job).filter((step) =>
    asString(step.uses).startsWith("actions/checkout@"),
  );
  if (checkouts.length !== 1) errors.push(`${jobName} must use exactly one checkout step`);
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
  const checkoutIndex = steps.findIndex((step) =>
    asString(step.uses).startsWith("actions/checkout@"),
  );
  if (steps.indexOf(login) !== checkoutIndex + 1) {
    errors.push(`${jobName} must authenticate immediately after credential-free checkout`);
  }
  if (steps.indexOf(cleanup) !== steps.length - 1) {
    errors.push(`${jobName} Docker auth cleanup must remain the final step`);
  }
  if (jobName === "mcp-bridge-dev") {
    const devCleanup = namedStep(job, DEV_DOCKER_CLEANUP_NAME);
    const install = namedStep(job, "Install OpenShell CLI");
    const expectedDevCleanup = {
      name: DEV_DOCKER_CLEANUP_NAME,
      shell: "bash",
      run: DOCKER_CLEANUP_RUN,
    };
    if (JSON.stringify(devCleanup) !== JSON.stringify(expectedDevCleanup)) {
      errors.push("mcp-bridge-dev must revoke Docker auth before unverified dev tooling");
    }
    const devCleanupIndex = steps.indexOf(devCleanup);
    const installIndex = steps.indexOf(install);
    if (devCleanupIndex <= steps.indexOf(login) || installIndex <= devCleanupIndex) {
      errors.push(
        "mcp-bridge-dev Docker auth revocation must follow setup and precede the dev installer",
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
  const install = namedStep(job, "Install OpenShell CLI");
  const run = namedStep(job, "Run MCP OpenShell provider live test");
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
    `${jobName} must generate its HTTPS fixture before installation`,
  );
  if (steps.indexOf(tls) < 0 || steps.indexOf(install) <= steps.indexOf(tls)) {
    errors.push(`${jobName} must generate HTTPS fixtures before installing OpenShell`);
  }
  requireEqual(
    errors,
    asRecord(install.env).NEMOCLAW_OPENSHELL_FORCE_INSTALL,
    "1",
    `${jobName} must force the selected OpenShell install`,
  );
  const installEnv = asRecord(install.env);
  if (jobName === "mcp-bridge-dev") {
    requireEqual(
      errors,
      installEnv.NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL,
      "1",
      "mcp-bridge-dev installer must explicitly authorize unverified dev artifacts",
    );
  } else if (Object.hasOwn(installEnv, "NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL")) {
    errors.push("mcp-bridge stable installer must not authorize unverified dev artifacts");
  }
  requireContains(
    errors,
    install.run,
    "bash scripts/install-openshell.sh",
    `${jobName} must use the repository OpenShell installer`,
  );
  for (const required of ["--project e2e-live", "test/e2e/live/mcp-bridge.test.ts"]) {
    requireContains(errors, run.run, required, `${jobName} must run the unified MCP live test`);
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
    `e2e-artifacts/live/${jobName}`,
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
    `e2e-artifacts/live/${jobName}/`,
    `${jobName} artifact upload must use exactly the scanned directory`,
  );
  requireEqual(
    errors,
    uploadOptions.name,
    `e2e-${jobName}`,
    `${jobName} artifact upload must use its isolated artifact name`,
  );
  if (Object.keys(uploadOptions).sort().join(",") !== "name,path") {
    errors.push(`${jobName} artifact upload must delegate policy to the reviewed shared uploader`);
  }
  if (steps.indexOf(scan) < 0 || steps.indexOf(upload) <= steps.indexOf(scan)) {
    errors.push(`${jobName} must scan artifacts before upload`);
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

  for (const terminalJobName of TERMINAL_JOBS) {
    const terminal = asRecord(jobs[terminalJobName]);
    const terminalNeeds = new Set(jobNeeds(terminal));
    for (const mcpJob of MCP_JOBS) {
      if (!terminalNeeds.has(mcpJob)) {
        errors.push(`${terminalJobName} must wait for ${mcpJob}`);
      }
    }
  }

  return errors;
}
