// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import {
  CLI_ARTIFACT_PRODUCER_JOB,
  PREPARE_E2E_ACTION,
  PREPARE_E2E_NO_BUILD_JOBS,
  PREPARE_E2E_TRUSTED_BUILD_JOBS,
} from "./prepare-e2e-workflow-boundary.mts";
import {
  contentSha256,
  MCP_DEV_JOB_EXECUTION_CONTEXT_SHA256,
  MCP_DEV_POST_INSTALL_TRANSITION_CONTENT_SHA256,
  MCP_DEV_TRUSTED_NODE_SETUP_CONTENT_SHA256,
  MCP_DEV_TRUSTED_PREFIX_CONTENT_SHA256,
  MCP_DEV_WORKFLOW_EXECUTION_CONTEXT_SHA256,
} from "./mcp-dev-workflow-boundary-digests.mts";
import { E2E_ACTION_PROVENANCE } from "./workflow-boundary-policy.mts";

export const CLI_ARTIFACT_DOWNLOAD_ACTION =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
export const CLI_ARTIFACT_UPLOAD_ACTION =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
export const CLI_ARTIFACT_RESTORE_ACTION = E2E_ACTION_PROVENANCE.restoreCliArtifact.reference;
export const CLI_ARTIFACT_PACKAGE_STEP = "Package exact-commit CLI";
export const CLI_ARTIFACT_PUBLISH_STEP = "Publish content-addressed CLI artifact";
export const CLI_ARTIFACT_RESTORE_STEP = "Restore exact-commit CLI artifact";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_RESTORE_ACTION_PATH = join(
  REPO_ROOT,
  ".github",
  "actions",
  "restore-e2e-cli-artifact",
  "action.yaml",
);
const RESTORE_ACTION_CONTENT_SHA256 = E2E_ACTION_PROVENANCE.restoreCliArtifact.contentSha256;
const CLI_ARTIFACT_DOWNLOAD_STEP = "Download exact-commit CLI artifact";
const CLI_ARTIFACT_VERIFY_STEP = "Verify and restore exact-commit CLI artifact";
const CLI_ARTIFACT_PROVENANCE_STEP = "Record CLI artifact provenance";
const CANDIDATE_CHECKOUT_STEP_CONTENT_SHA256 =
  "80a0506fc363084ae181a7f562f56dfa1f3243a69bb433d2a78379f3a213bd45";
type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  env?: WorkflowRecord;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: WorkflowRecord;
};

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function steps(value: unknown): WorkflowStep[] {
  return Array.isArray(value) ? (value as WorkflowStep[]) : [];
}

function hasUnsafeProcessHook(value: unknown): boolean {
  const environment = record(value);
  return (
    Object.hasOwn(environment, "NODE_OPTIONS") ||
    ["BASH_ENV", "ENV"].some(
      (name) => Object.hasOwn(environment, name) && environment[name] !== "/dev/null",
    )
  );
}

function isCliArtifactRestoreStep(step: WorkflowStep): boolean {
  return (
    step.name === CLI_ARTIFACT_RESTORE_STEP ||
    (typeof step.uses === "string" &&
      step.uses.startsWith("NVIDIA/NemoClaw/.github/actions/restore-e2e-cli-artifact@"))
  );
}

function requireFragments(
  errors: string[],
  owner: string,
  source: unknown,
  fragments: readonly string[],
): void {
  const script = typeof source === "string" ? source : "";
  for (const fragment of fragments) {
    if (!script.includes(fragment)) errors.push(`${owner} must contain ${fragment}`);
  }
}

export function validateCliArtifactRestoreAction(
  actionPath = DEFAULT_RESTORE_ACTION_PATH,
): string[] {
  const errors: string[] = [];
  let actionSource: string;
  try {
    actionSource = readFileSync(actionPath, "utf8");
  } catch {
    return ["CLI artifact restore action file is missing or unreadable"];
  }
  if (createHash("sha256").update(actionSource).digest("hex") !== RESTORE_ACTION_CONTENT_SHA256) {
    errors.push("CLI artifact restore action must match its immutable workflow pin");
  }
  const action = record(YAML.parse(actionSource));
  const inputNames = ["provenance-json"];
  const inputs = record(action.inputs);
  if (
    !isDeepStrictEqual(Object.keys(inputs).sort(), inputNames) ||
    !inputNames.every((name) => record(inputs[name]).required === true)
  ) {
    errors.push("CLI artifact restore action must require the complete provenance input set");
  }
  const actionSteps = steps(record(action.runs).steps);
  if (record(action.runs).using !== "composite" || actionSteps.length !== 3) {
    errors.push("CLI artifact restore action must keep the three-step composite boundary");
    return errors;
  }
  const [identity, download, restore] = actionSteps;
  if (
    identity?.name !== "Validate exact-commit CLI artifact identity" ||
    identity?.id !== "identity" ||
    identity?.shell !== "bash" ||
    !isDeepStrictEqual(record(identity.env), {
      CALLER_WORKFLOW_SHA: "${{ github.workflow_sha }}",
      PROVENANCE_JSON: "${{ inputs.provenance-json }}",
    })
  ) {
    errors.push("CLI artifact restore action must validate identity before download");
  }
  requireFragments(errors, "CLI artifact identity validation", identity?.run, [
    "(keys | sort) == [",
    '.kind == "nemoclaw-e2e-cli-provenance-v1"',
    '.artifactId | strings | test("^[1-9][0-9]*$")',
    '.artifactDigest | strings | test("^[a-f0-9]{64}$")',
    '.candidateSha | strings | test("^[a-f0-9]{40}$")',
    '.payloadSha256 | strings | test("^[a-f0-9]{64}$")',
    '.workflowSha | strings | test("^[a-f0-9]{40}$")',
    '.artifactName == ("nemoclaw-cli-" + .candidateSha + "-" + .payloadSha256)',
    'git rev-parse --verify HEAD)" == "$candidate_sha"',
    '[[ "$workflow_sha" == "$CALLER_WORKFLOW_SHA" ]]',
    '[[ "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]',
    '[[ "$run_id" == "$GITHUB_RUN_ID" ]]',
    "(( run_attempt <= GITHUB_RUN_ATTEMPT ))",
    '[[ "$remote_repository" == "$candidate_repository" ]]',
    '<<<"$PROVENANCE_JSON" >>"$GITHUB_OUTPUT"',
  ]);
  if (
    download?.name !== CLI_ARTIFACT_DOWNLOAD_STEP ||
    download?.uses !== CLI_ARTIFACT_DOWNLOAD_ACTION ||
    !isDeepStrictEqual(record(download.with), {
      "artifact-ids": "${{ steps.identity.outputs.artifact_id }}",
      path: "${{ runner.temp }}/nemoclaw-cli-artifact",
      "digest-mismatch": "error",
    })
  ) {
    errors.push("CLI artifact restore action must download by immutable ID and reject mismatch");
  }
  if (restore?.name !== CLI_ARTIFACT_VERIFY_STEP || restore?.shell !== "bash") {
    errors.push("CLI artifact restore action must verify the downloaded payload in bash");
  }
  if (
    !isDeepStrictEqual(record(restore?.env), {
      ARTIFACT_NAME: "${{ steps.identity.outputs.artifact_name }}",
      CANDIDATE_REPOSITORY: "${{ steps.identity.outputs.candidate_repository }}",
      CANDIDATE_SHA: "${{ steps.identity.outputs.candidate_sha }}",
      PAYLOAD_SHA256: "${{ steps.identity.outputs.payload_sha256 }}",
      PRODUCER_RUN_ATTEMPT: "${{ steps.identity.outputs.producer_run_attempt }}",
      RUN_ID: "${{ steps.identity.outputs.run_id }}",
      WORKFLOW_SHA: "${{ steps.identity.outputs.workflow_sha }}",
    })
  ) {
    errors.push("CLI artifact restore action must pass validated identity to payload verification");
  }
  requireFragments(errors, "CLI artifact payload verification", restore?.run, [
    ".candidate.sha == $candidateSha",
    ".candidate.sourceTree == $sourceTree",
    ".candidate.lockfileSha256 == $lockfileSha256",
    ".workflow.sha == $workflowSha",
    ".workflow.runId == $runId",
    ".workflow.runAttempt == $runAttempt",
    ".build.sourceRevision == $candidateSha",
    ".payload.sha256 == $payloadSha256",
    '[[ "$actual_payload_sha256" == "$PAYLOAD_SHA256" ]]',
    '*) echo "::error::CLI artifact contains an unsafe member',
    "CLI artifact contains a link or special file",
    '[[ ! -e "$GITHUB_WORKSPACE/dist" && ! -L "$GITHUB_WORKSPACE/dist" ]]',
    '[[ -d "$GITHUB_WORKSPACE/nemoclaw" && ! -L "$GITHUB_WORKSPACE/nemoclaw" ]]',

    '[[ ! -e "$GITHUB_WORKSPACE/nemoclaw/dist" && ! -L "$GITHUB_WORKSPACE/nemoclaw/dist" ]]',

    'restore_dir="$(mktemp -d',
    'tar --no-same-owner --no-same-permissions -xf "$payload" -C "$restore_dir"',
    '[[ -f "$cli_entrypoint" && ! -L "$cli_entrypoint" && -s "$cli_entrypoint" ]]',
    "sandbox-name.cjs",
    '[[ -f "$boundary_path" && ! -L "$boundary_path" && -s "$boundary_path" ]]',

    ".sourceRevision == $candidateSha",
    'mv "$restore_dir/nemoclaw/dist" "$GITHUB_WORKSPACE/nemoclaw/dist"',

    'mv "$restore_dir/dist" "$GITHUB_WORKSPACE/dist"',
    'node "$GITHUB_WORKSPACE/bin/nemoclaw.js" --version',
  ]);
  return errors;
}

function validateProducer(errors: string[], producer: WorkflowRecord): void {
  const outputs = record(producer.outputs);
  const requiredOutputs = {
    cli_artifact_provenance: "${{ steps.record_cli_artifact.outputs.provenance }}",
  };
  for (const [name, value] of Object.entries(requiredOutputs)) {
    if (outputs[name] !== value) {
      errors.push(`${CLI_ARTIFACT_PRODUCER_JOB} must expose exact ${name} provenance`);
    }
  }

  const producerSteps = steps(producer.steps);
  const packageSteps = producerSteps.filter((step) => step.name === CLI_ARTIFACT_PACKAGE_STEP);
  const uploadSteps = producerSteps.filter((step) => step.name === CLI_ARTIFACT_PUBLISH_STEP);
  const provenanceSteps = producerSteps.filter(
    (step) => step.name === CLI_ARTIFACT_PROVENANCE_STEP,
  );
  if (packageSteps.length !== 1) {
    errors.push(`${CLI_ARTIFACT_PRODUCER_JOB} must package the CLI artifact exactly once`);
  }
  if (uploadSteps.length !== 1) {
    errors.push(`${CLI_ARTIFACT_PRODUCER_JOB} must publish the CLI artifact exactly once`);
  }
  if (provenanceSteps.length !== 1) {
    errors.push(`${CLI_ARTIFACT_PRODUCER_JOB} must record CLI artifact provenance exactly once`);
  }
  const packageStep = packageSteps[0];
  const uploadStep = uploadSteps[0];
  const provenanceStep = provenanceSteps[0];
  if (!packageStep || !uploadStep || !provenanceStep) return;

  if (packageStep.id !== "package_cli_artifact" || packageStep.shell !== "bash") {
    errors.push("CLI artifact package step must use id package_cli_artifact and the Bash shell");
  }
  if (
    !isDeepStrictEqual(record(packageStep.env), {
      CANDIDATE_REPOSITORY: "${{ inputs.checkout_repository || github.repository }}",
      CANDIDATE_SHA: "${{ inputs.checkout_sha || github.sha }}",
      RUN_ATTEMPT: "${{ github.run_attempt }}",
      RUN_ID: "${{ github.run_id }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    })
  ) {
    errors.push(
      "CLI artifact package step must bind candidate and trusted workflow identities explicitly",
    );
  }
  requireFragments(errors, "CLI artifact package step", packageStep.run, [
    'git rev-parse --verify HEAD)" == "$CANDIDATE_SHA"',
    "for required_file in dist/nemoclaw.js dist/build-identity.json; do",
    '[[ -f "$required_file" && ! -L "$required_file" && -s "$required_file" ]]',
    "sandbox-name.cjs",
    '[[ -f "$boundary_path" && ! -L "$boundary_path" && -s "$boundary_path" ]]',

    ".sourceRevision == $candidateSha",
    "candidate CLI build identity does not match the candidate commit SHA",
    ".source.revision == $revision",
    ".source.release == $release",
    "managed-image catalog source identity does not match the candidate",
    "--sort=name",
    "--mtime=@0",
    "nemoclaw/dist/shared",

    "source_tree=\"$(git rev-parse 'HEAD^{tree}')\"",
    'lockfile_sha256="$(sha256sum package-lock.json',
    'artifact_name="nemoclaw-cli-${CANDIDATE_SHA}-${payload_sha256}"',
    'kind: "nemoclaw-e2e-cli-artifact-v1"',
    "sha: $candidateSha",
    "sha: $workflowSha",
    "sourceRevision: $candidateSha",
    "sha256: $payloadSha256",
  ]);

  if (
    uploadStep.id !== "upload_cli_artifact" ||
    uploadStep.uses !== CLI_ARTIFACT_UPLOAD_ACTION ||
    !isDeepStrictEqual(record(uploadStep.with), {
      name: "${{ steps.package_cli_artifact.outputs.artifact_name }}",
      path: "${{ runner.temp }}/nemoclaw-cli-artifact/",
      "if-no-files-found": "error",
      "retention-days": 3,
      "compression-level": 0,
    })
  ) {
    errors.push("CLI artifact upload must use the immutable content-addressed upload contract");
  }
  if (
    provenanceStep.id !== "record_cli_artifact" ||
    !isDeepStrictEqual(record(provenanceStep.env), {
      ARTIFACT_DIGEST: "${{ steps.upload_cli_artifact.outputs.artifact-digest }}",
      ARTIFACT_ID: "${{ steps.upload_cli_artifact.outputs.artifact-id }}",
      ARTIFACT_NAME: "${{ steps.package_cli_artifact.outputs.artifact_name }}",
      CANDIDATE_REPOSITORY: "${{ inputs.checkout_repository || github.repository }}",
      CANDIDATE_SHA: "${{ steps.package_cli_artifact.outputs.candidate_sha }}",
      PAYLOAD_SHA256: "${{ steps.package_cli_artifact.outputs.payload_sha256 }}",
      RUN_ATTEMPT: "${{ github.run_attempt }}",
      RUN_ID: "${{ github.run_id }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    })
  ) {
    errors.push("CLI artifact provenance step must consume the immutable upload outputs");
  }
  requireFragments(errors, "CLI artifact provenance step", provenanceStep.run, [
    '[[ "$ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]',
    '[[ "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]]',
    'kind: "nemoclaw-e2e-cli-provenance-v1"',
    "artifactDigest: $artifactDigest",
    "candidateRepository: $candidateRepository",
    "workflowSha: $workflowSha",
    'printf \'provenance=%s\\n\' "$provenance" >>"$GITHUB_OUTPUT"',
    'echo "- Candidate: \\`${CANDIDATE_SHA}\\`"',
    'echo "- Payload digest: \\`${PAYLOAD_SHA256}\\`"',
  ]);

  const prepareIndex = producerSteps.findIndex((step) => step.uses === PREPARE_E2E_ACTION);
  const packageIndex = producerSteps.indexOf(packageStep);
  const uploadIndex = producerSteps.indexOf(uploadStep);
  const provenanceIndex = producerSteps.indexOf(provenanceStep);
  if (
    !(
      prepareIndex >= 0 &&
      prepareIndex < packageIndex &&
      packageIndex < uploadIndex &&
      uploadIndex < provenanceIndex
    )
  ) {
    errors.push("CLI artifact producer must build, package, upload, then record provenance");
  }
}

function validateConsumer(
  errors: string[],
  jobName: string,
  job: WorkflowRecord,
  jobSteps: WorkflowStep[],
): void {
  if (jobName === "mcp-bridge-dev") {
    const { steps: _jobSteps, ...jobExecutionContext } = job;
    if (
      contentSha256(jobExecutionContext) !== MCP_DEV_JOB_EXECUTION_CONTEXT_SHA256
    ) {
      errors.push(
        "mcp-bridge-dev must preserve its reviewed job execution context before candidate activation",
      );
    }
  }
  let expectedNeeds: string | string[] = CLI_ARTIFACT_PRODUCER_JOB;
  if (jobName === "mcp-bridge-dev") {
    expectedNeeds = [CLI_ARTIFACT_PRODUCER_JOB, "openshell-dev-artifact"];
  } else if (jobName === "live") {
    expectedNeeds = ["base-image-publication", CLI_ARTIFACT_PRODUCER_JOB];
  } else if (jobName === "cloud-onboard") {
    expectedNeeds = ["base-image-publication", CLI_ARTIFACT_PRODUCER_JOB];
  }
  if (!isDeepStrictEqual(job.needs, expectedNeeds)) {
    errors.push(`${jobName} must depend directly on the CLI artifact producer`);
  }
  const candidateCheckoutIndexes = jobSteps.flatMap((step, index) =>
    contentSha256(step) === CANDIDATE_CHECKOUT_STEP_CONTENT_SHA256 ? [index] : [],
  );
  if (candidateCheckoutIndexes.length !== 1) {
    errors.push(
      `${jobName} must use one candidate checkout with the required action, repository, ref, and credential settings`,
    );
  }
  const prepareIndex = jobSteps.findIndex((step) => step.uses === PREPARE_E2E_ACTION);
  const restoreSteps = jobSteps.filter(isCliArtifactRestoreStep);
  if (restoreSteps.length !== 1) {
    errors.push(`${jobName} must verify and restore the exact CLI artifact exactly once`);
  }
  const restore = restoreSteps[0];
  if (!restore) return;

  if (
    restore.uses !== CLI_ARTIFACT_RESTORE_ACTION ||
    !isDeepStrictEqual(record(restore.with), {
      "provenance-json": "${{ needs.generate-matrix.outputs.cli_artifact_provenance }}",
    })
  ) {
    errors.push(`${jobName} must use the immutable complete CLI artifact restore contract`);
  }
  const restoreIndex = jobSteps.indexOf(restore);
  const trustedInstallIndex = jobSteps.findIndex(
    (step) => step.name === "Install immutable OpenShell dev artifact",
  );
  const securityBoundaryIndex =
    jobName === "mcp-bridge-dev"
      ? trustedInstallIndex >= 0
        ? trustedInstallIndex
        : jobSteps.length - 1
      : restoreIndex;
  const stepsThroughSecurityBoundary = jobSteps.slice(
    0,
    securityBoundaryIndex + 1,
  );
  const jobEnv = record(job.env);
  const defaultShell = record(record(job.defaults).run).shell;
  const unsafePreRestoreStep = stepsThroughSecurityBoundary.some(
    (step) =>
      hasUnsafeProcessHook(step.env) ||
      step.uses?.startsWith("./") ||
      (jobName !== "hermes-gpu-startup" &&
        (/GITHUB_WORKSPACE/u.test(step.run ?? "") ||
          /(?:^|\s)(?:(?:ba|da|z)?sh\s+(?:-\S+\s+)*)?(?:[.]?\/|\S*\/)?install[.]sh\b/u.test(
            step.run ?? "",
          ))),
  );
  if (hasUnsafeProcessHook(jobEnv) || defaultShell !== undefined || unsafePreRestoreStep) {
    errors.push(
      jobName === "mcp-bridge-dev"
        ? "mcp-bridge-dev must not use candidate-controlled process hooks before trusted installation"
        : `${jobName} must not use candidate-controlled process hooks before CLI artifact restore`,
    );
  }
  const candidateCheckoutIndex = candidateCheckoutIndexes[0] ?? -1;
  if (jobName === "mcp-bridge-dev") {
    const trustedNodeSetupIndexes = jobSteps.flatMap((step, index) =>
      contentSha256(step) === MCP_DEV_TRUSTED_NODE_SETUP_CONTENT_SHA256 ? [index] : [],
    );
    if (
      trustedNodeSetupIndexes.length !== 1 ||
      trustedNodeSetupIndexes[0] !== candidateCheckoutIndex - 1
    ) {
      errors.push(
        "mcp-bridge-dev must set up Node.js without dependency caching before candidate checkout",
      );
    }
  }
  if (candidateCheckoutIndex >= restoreIndex) {
    errors.push(`${jobName} must check out the candidate before CLI artifact restore`);
  }
  if (!(prepareIndex >= 0 && prepareIndex < restoreIndex)) {
    errors.push(`${jobName} must prepare before restoring the CLI artifact`);
  }
  if (
    jobName === "mcp-bridge-dev" &&
    (trustedInstallIndex < 0 ||
      contentSha256(jobSteps.slice(0, trustedInstallIndex + 1)) !==
        MCP_DEV_TRUSTED_PREFIX_CONTENT_SHA256)
  ) {
    errors.push(
      "mcp-bridge-dev must preserve every reviewed step through trusted installation",
    );
  }
  if (
    jobName === "mcp-bridge-dev" &&
    (prepareIndex < 0 ||
      restoreIndex < prepareIndex ||
      contentSha256(jobSteps.slice(prepareIndex, restoreIndex + 1)) !==
        MCP_DEV_POST_INSTALL_TRANSITION_CONTENT_SHA256)
  ) {
    errors.push(
      "mcp-bridge-dev must preserve reviewed dependency preparation and candidate CLI restore after trusted installation",
    );
  }
  const reviewedStepsBeforeRestore =
    jobName === "live"
      ? ["Record immutable Deep Agents Code base evidence"]
      : jobName === "mcp-bridge-dev"
        ? [
            "Authenticate to Docker Hub",
            "Checkout trusted OpenShell dev tooling",
            "Restore immutable OpenShell dev artifact",
            "Verify immutable OpenShell dev artifact",
            "Revoke Docker auth before OpenShell development tooling",
            "Install immutable OpenShell dev artifact",
            "Prepare E2E workspace",
          ]
        : [];
  const reviewedStepsStart =
    jobName === "mcp-bridge-dev" ? candidateCheckoutIndex + 1 : prepareIndex + 1;
  const stepsBeforeRestore = jobSteps
    .slice(reviewedStepsStart, restoreIndex)
    .map((step) => step.name);
  if (
    prepareIndex >= 0 &&
    !isDeepStrictEqual(stepsBeforeRestore, reviewedStepsBeforeRestore)
  ) {
    errors.push(
      `${jobName} must preserve its reviewed steps through CLI artifact restore`,
    );
  }
}

export function validateCliArtifactWorkflowBoundary(
  workflow: WorkflowRecord,
  actionPath = DEFAULT_RESTORE_ACTION_PATH,
): string[] {
  const errors = validateCliArtifactRestoreAction(actionPath);
  const workflowEnv = record(workflow.env);
  if (
    contentSha256({ env: workflow.env, defaults: workflow.defaults }) !==
    MCP_DEV_WORKFLOW_EXECUTION_CONTEXT_SHA256
  ) {
    errors.push(
      "workflow must preserve the reviewed execution environment before candidate activation",
    );
  }
  if (hasUnsafeProcessHook(workflowEnv)) {
    errors.push("workflow must not set process startup hooks before CLI artifact restore");
  }
  const jobs = record(workflow.jobs);
  const producer = record(jobs[CLI_ARTIFACT_PRODUCER_JOB]);
  if (Object.keys(producer).length === 0) {
    errors.push(`workflow is missing CLI artifact producer ${CLI_ARTIFACT_PRODUCER_JOB}`);
    return errors;
  }
  validateProducer(errors, producer);

  if (Object.keys(record(jobs["mcp-bridge-dev"])).length === 0) {
    errors.push("workflow is missing required CLI artifact consumer mcp-bridge-dev");
  }

  for (const [jobName, value] of Object.entries(jobs)) {
    const job = record(value);
    const jobSteps = steps(job.steps);
    const usesPrepare = jobSteps.some((step) => step.uses === PREPARE_E2E_ACTION);
    const artifactSteps = jobSteps.filter(isCliArtifactRestoreStep);
    const shouldConsume =
      (usesPrepare || jobName === "mcp-bridge-dev") &&
      jobName !== CLI_ARTIFACT_PRODUCER_JOB &&
      !PREPARE_E2E_NO_BUILD_JOBS.has(jobName) &&
      !PREPARE_E2E_TRUSTED_BUILD_JOBS.has(jobName);
    if (shouldConsume) {
      validateConsumer(errors, jobName, job, jobSteps);
    } else if (artifactSteps.length > 0) {
      errors.push(`${jobName} must not consume the shared CLI artifact`);
    }
  }

  return errors;
}
