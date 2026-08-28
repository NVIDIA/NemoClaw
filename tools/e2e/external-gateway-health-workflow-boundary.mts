// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { PREPARE_E2E_ACTION } from "./prepare-e2e-workflow-boundary.mts";
import { UPLOAD_E2E_ARTIFACTS_ACTION } from "./upload-e2e-artifacts-workflow-boundary.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const PACKAGE_JOB = "package-openshell-sdk";
const HEALTH_JOB = "external-gateway-health";
const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_ACTION = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const DOWNLOAD_ACTION = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

type WorkflowStep = {
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  "runs-on"?: string;
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
};

export type ExternalGatewayHealthWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

export function readExternalGatewayHealthWorkflow(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): ExternalGatewayHealthWorkflow {
  return YAML.parse(readFileSync(workflowPath, "utf8")) as ExternalGatewayHealthWorkflow;
}

function findStep(job: WorkflowJob, name: string): WorkflowStep {
  return job.steps?.find((step) => step.name === name) ?? {};
}

function sameMembers(value: string | string[] | undefined, expected: readonly string[]): boolean {
  const actual = Array.isArray(value) ? value : value ? [value] : [];
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function requireOrder(
  errors: string[],
  steps: WorkflowStep[],
  beforeName: string,
  afterName: string,
): void {
  const before = steps.findIndex((step) => step.name === beforeName);
  const after = steps.findIndex((step) => step.name === afterName);
  if (before < 0 || after < 0 || before >= after) {
    errors.push(`${HEALTH_JOB} step '${beforeName}' must precede '${afterName}'`);
  }
}

function validatePackageJob(errors: string[], job: WorkflowJob): void {
  if (
    job.if !==
    "${{ github.event_name == 'workflow_dispatch' && contains(format(',{0},', inputs.jobs), ',external-gateway-health,') }}"
  ) {
    errors.push(`${PACKAGE_JOB} must run only for the explicit external health selector`);
  }
  if (
    job["runs-on"] !== "ubuntu-latest" ||
    job["timeout-minutes"] !== 5 ||
    JSON.stringify(job.permissions) !== JSON.stringify({ contents: "read", packages: "read" })
  ) {
    errors.push(`${PACKAGE_JOB} must retain its bounded package-read trust boundary`);
  }
  if (job.outputs?.artifact_name !== "${{ steps.identity.outputs.artifact_name }}") {
    errors.push(`${PACKAGE_JOB} must expose only the recorded artifact name`);
  }

  const steps = job.steps ?? [];
  const checkout = findStep(job, "Check out trusted OpenShell SDK package verifier");
  const sparse = String(checkout.with?.["sparse-checkout"] ?? "")
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
  const expectedSparse = [
    "ci/reviewed-npm-audit.json",
    "scripts/audit-reviewed-npm-graph.mts",
    "scripts/checks/package-openshell-sdk-for-pr.mts",
    "scripts/lib/openclaw-npm-remediation.mts",
    "scripts/lib/reviewed-npm-archive.mts",
    "scripts/lib/reviewed-npm-audit.mts",
  ].sort();
  if (
    checkout.uses !== CHECKOUT_ACTION ||
    checkout.with?.ref !== "${{ github.workflow_sha }}" ||
    checkout.with?.["persist-credentials"] !== false ||
    checkout.with?.["sparse-checkout-cone-mode"] !== false ||
    JSON.stringify(sparse) !== JSON.stringify(expectedSparse)
  ) {
    errors.push(`${PACKAGE_JOB} must execute only the trusted sparse package verifier checkout`);
  }

  const setup = findStep(job, "Set up Node for reviewed package download");
  if (
    setup.uses !== SETUP_NODE_ACTION ||
    setup.with?.["node-version"] !== "22" ||
    setup.with?.["registry-url"] !== "https://npm.pkg.github.com" ||
    setup.with?.scope !== "@nvidia"
  ) {
    errors.push(`${PACKAGE_JOB} must use the reviewed Node and GitHub Packages setup`);
  }

  const download = findStep(job, "Download and verify exact OpenShell SDK package");
  if (
    download.id !== "package" ||
    download.env?.NEMOCLAW_OPEN_SHELL_SDK_OUTPUT_DIRECTORY !== "${{ runner.temp }}/openshell-sdk" ||
    download.env?.NODE_AUTH_TOKEN !== "${{ github.token }}" ||
    !download.run?.includes(
      "node --experimental-strip-types scripts/checks/package-openshell-sdk-for-pr.mts",
    )
  ) {
    errors.push(`${PACKAGE_JOB} must scope its package credential to the reviewed downloader`);
  }

  const identity = findStep(job, "Record reviewed OpenShell SDK artifact identity");
  if (
    identity.id !== "identity" ||
    identity.env?.RUN_ATTEMPT !== "${{ github.run_attempt }}" ||
    identity.env?.RUN_ID !== "${{ github.run_id }}" ||
    !identity.run?.includes('artifact_name="openshell-sdk-e2e-${RUN_ID}-${RUN_ATTEMPT}"')
  ) {
    errors.push(`${PACKAGE_JOB} must bind the artifact name to this workflow attempt`);
  }

  const upload = findStep(job, "Upload reviewed OpenShell SDK archive");
  if (
    upload.uses !== UPLOAD_ACTION ||
    upload.with?.name !== "${{ steps.identity.outputs.artifact_name }}" ||
    upload.with?.path !== "${{ steps.package.outputs.artifact_path }}" ||
    upload.with?.["if-no-files-found"] !== "error" ||
    upload.with?.["retention-days"] !== 1
  ) {
    errors.push(`${PACKAGE_JOB} must publish only the exact one-day reviewed archive`);
  }
  requireOrder(errors, steps, checkout.name ?? "", setup.name ?? "");
  requireOrder(errors, steps, setup.name ?? "", download.name ?? "");
  requireOrder(errors, steps, download.name ?? "", upload.name ?? "");
}

function validateHealthJob(errors: string[], job: WorkflowJob): void {
  if (!sameMembers(job.needs, ["generate-matrix", PACKAGE_JOB])) {
    errors.push(`${HEALTH_JOB} must wait for the candidate CLI and reviewed SDK archive`);
  }
  if (
    job.if !==
    "${{ contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'external-gateway-health') }}"
  ) {
    errors.push(`${HEALTH_JOB} must use the trusted explicit selection and dependency gate`);
  }
  if (job["runs-on"] !== "ubuntu-latest" || job["timeout-minutes"] !== 15) {
    errors.push(`${HEALTH_JOB} must retain its 15 minute Ubuntu resource budget`);
  }
  const env = job.env ?? {};
  const expectedEnv = {
    E2E_AGENT_RUNTIME: "none",
    E2E_ARTIFACT_DIR: "${{ github.workspace }}/e2e-artifacts/live/external-gateway-health",
    E2E_DEFAULT_ENABLED: "0",
    E2E_ENVIRONMENT_OR_INFERENCE_ENDPOINT:
      "Ubuntu host with OpenShell 0.0.106; no inference endpoint",
    E2E_JOB: "1",
    E2E_NON_INTERACTIVE: undefined,
    E2E_OBSERVABLE_OUTCOME:
      "The reviewed SDK observes exact public gateway health over explicit HTTPS and CA",
    E2E_TARGET_ID: HEALTH_JOB,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_OPENSHELL_PIN_VERSION: "0.0.106",
    NEMOCLAW_RUN_LIVE_E2E: "1",
  };
  for (const [name, value] of Object.entries(expectedEnv)) {
    if (value === undefined ? Object.hasOwn(env, name) : env[name] !== value) {
      errors.push(`${HEALTH_JOB} must retain ${name}=${String(value)}`);
    }
  }
  for (const name of ["GITHUB_TOKEN", "NODE_AUTH_TOKEN", "NVIDIA_API_KEY"]) {
    if (Object.hasOwn(env, name)) errors.push(`${HEALTH_JOB} must not expose ${name} at job scope`);
  }

  const steps = job.steps ?? [];
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@")) ?? {};
  if (
    checkout.uses !== CHECKOUT_ACTION ||
    checkout.with?.repository !== "${{ inputs.checkout_repository || github.repository }}" ||
    checkout.with?.ref !== "${{ inputs.checkout_sha || github.sha }}" ||
    checkout.with?.["fetch-depth"] !== 0 ||
    checkout.with?.["persist-credentials"] !== false
  ) {
    errors.push(
      `${HEALTH_JOB} must use the exact candidate checkout without persisted credentials`,
    );
  }
  const prepare = findStep(job, "Prepare E2E workspace");
  if (prepare.uses !== PREPARE_E2E_ACTION || prepare.with?.["build-cli"] !== "false") {
    errors.push(`${HEALTH_JOB} must use the reviewed dependency preparation without rebuilding`);
  }
  const restore = findStep(job, "Restore exact-commit CLI artifact");
  if (
    !restore.uses?.startsWith("NVIDIA/NemoClaw/.github/actions/restore-e2e-cli-artifact@") ||
    restore.with?.["provenance-json"] !==
      "${{ needs.generate-matrix.outputs.cli_artifact_provenance }}"
  ) {
    errors.push(`${HEALTH_JOB} must restore the exact candidate CLI artifact`);
  }
  const download = findStep(job, "Download reviewed OpenShell SDK archive");
  if (
    download.uses !== DOWNLOAD_ACTION ||
    download.with?.name !== "${{ needs.package-openshell-sdk.outputs.artifact_name }}" ||
    download.with?.path !== "${{ runner.temp }}/openshell-sdk"
  ) {
    errors.push(`${HEALTH_JOB} must download only this run's reviewed SDK archive`);
  }
  const installSdk = findStep(
    job,
    "Install reviewed OpenShell SDK archive without package credentials",
  );
  for (const fragment of [
    "env -u NODE_AUTH_TOKEN -u GITHUB_TOKEN",
    'npm install --no-save --package-lock=false --ignore-scripts "${archives[0]}"',
  ]) {
    if (!installSdk.run?.includes(fragment)) {
      errors.push(`${HEALTH_JOB} SDK install must retain: ${fragment}`);
    }
  }
  const installOpenShell = findStep(job, "Install OpenShell CLI");
  if (
    installOpenShell.run !==
    "env -u NODE_AUTH_TOKEN -u GITHUB_TOKEN bash scripts/install-openshell.sh"
  ) {
    errors.push(`${HEALTH_JOB} OpenShell install must not receive package credentials`);
  }
  const run = findStep(job, "Run external gateway health live test");
  if (
    !run.run?.includes("tools/e2e/live-vitest-invocation.mts run") ||
    !run.run?.includes("test/e2e/live/external-gateway-health.test.ts") ||
    Object.keys(run.env ?? {}).length > 0 ||
    JSON.stringify(run).includes("secrets.")
  ) {
    errors.push(`${HEALTH_JOB} must run only the credential-free external health test`);
  }
  const upload = findStep(job, "Upload external gateway health artifacts");
  if (
    upload.if !== "always()" ||
    upload.uses !== UPLOAD_E2E_ARTIFACTS_ACTION ||
    upload.with?.name !== "e2e-external-gateway-health" ||
    upload.with?.path !== "e2e-artifacts/live/external-gateway-health/"
  ) {
    errors.push(`${HEALTH_JOB} must always use the reviewed artifact uploader`);
  }
  requireOrder(errors, steps, prepare.name ?? "", restore.name ?? "");
  requireOrder(errors, steps, restore.name ?? "", download.name ?? "");
  requireOrder(errors, steps, download.name ?? "", installSdk.name ?? "");
  requireOrder(errors, steps, installSdk.name ?? "", run.name ?? "");
  requireOrder(errors, steps, run.name ?? "", upload.name ?? "");
}

export function validateExternalGatewayHealthWorkflow(
  workflow: ExternalGatewayHealthWorkflow,
): string[] {
  const errors: string[] = [];
  const packageJob = workflow.jobs[PACKAGE_JOB];
  const healthJob = workflow.jobs[HEALTH_JOB];
  if (!packageJob) errors.push(`workflow is missing ${PACKAGE_JOB}`);
  else validatePackageJob(errors, packageJob);
  if (!healthJob) errors.push(`workflow is missing ${HEALTH_JOB}`);
  else validateHealthJob(errors, healthJob);
  return errors;
}

export function validateExternalGatewayHealthWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  return validateExternalGatewayHealthWorkflow(readExternalGatewayHealthWorkflow(workflowPath));
}
