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

export const CLI_ARTIFACT_DOWNLOAD_ACTION =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
export const CLI_ARTIFACT_UPLOAD_ACTION =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
export const CLI_ARTIFACT_RESTORE_ACTION =
  "NVIDIA/NemoClaw/.github/actions/restore-e2e-cli-artifact@d34b11e8b895760d6505d54e2cfc520332cb2a9c";
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
const RESTORE_ACTION_CONTENT_SHA256 =
  "f90d4532a64473817b183856e225b401b201d71aaafa75bd7cf8d63a3deeb76f";
const CLI_ARTIFACT_DOWNLOAD_STEP = "Download exact-commit CLI artifact";
const CLI_ARTIFACT_VERIFY_STEP = "Verify and restore exact-commit CLI artifact";
const CLI_ARTIFACT_PROVENANCE_STEP = "Record CLI artifact provenance";
const CANDIDATE_CHECKOUT_STEP_CONTENT_SHA256 =
  "3578a053cede863f7aa4814d8399b4ca21ea0b77cee712e6d549c684818f11dd";
const PRE_RESTORE_SEQUENCE_CONTRACTS = [
  [
    "1fac2df5e6430b32c1a2e81b77518b926c88965938c9c796f1b34a728bd94a08",
    ["retired-selector-compatibility", "shared-e2e"],
  ],
  ["b8c97e0db63418f63be0422863793da118ce19a6fbcca5722e1568e911ffcc83", ["live"]],
  [
    "acbb85218d608bb0bfe3c38663b1f1fbe36a21f226718cfd5a84823cb7b9167a",
    [
      "openshell-gateway-auth-contract",
      "openshell-credential-generation-window",
      "mcp-bridge-dev",
      "skill-agent",
      "openclaw-skill-cli",
      "inference-routing",
      "cloud-inference",
      "gpu-e2e",
      "kimi-inference-compat",
      "brave-search",
      "cron-preflight-inference-local",
      "dashboard-remote-bind",
      "sessions-agents-cli",
      "hermes-slack",
      "rebuild-openclaw",
      "rebuild-hermes",
      "rebuild-hermes-stale-base",
      "overlayfs-autofix",
      "state-backup-restore",
      "double-onboard",
      "concurrent-gateway-ports",
      "onboard-resume",
      "full-e2e",
      "gpu-double-onboard",
      "onboard-repair",
      "issue-4462-scope-upgrade-approval",
      "token-rotation",
      "messaging-compatible-endpoint",
      "openshell-gateway-upgrade",
      "messaging-providers",
      "model-router-provider-routed-inference",
      "sandbox-operations",
      "sandbox-survival",
      "gateway-guard-recovery",
      "openclaw-inference-switch",
      "device-auth-health",
      "channels-add-remove",
      "telegram-injection",
      "openclaw-slack-pairing",
      "issue-2478-crash-loop-recovery",
      "openclaw-discord-pairing",
      "tunnel-lifecycle",
    ],
  ],
  [
    "3177a567702646812f9d59ded26130fbb387cbff02c044212045adabbd200181",
    ["mcp-bridge", "bedrock-runtime-compatible-anthropic", "channels-stop-start"],
  ],
  [
    "696be20eb1b8216289007991468eff5cb69aaeb029341fc040278d1b099e2533",
    ["agent-turn-latency", "hermes-inference-switch", "hermes-discord", "hermes-shields-config"],
  ],
  [
    "f77a5a2830b1ae59c98f695d47b0af1e74c4b56485fffa9e0b61581b1afafc11",
    ["issue-4434-tui-unreachable-inference"],
  ],
  ["715a740435f7daa9a93a0626772b178d3f72e58dc55e89cb61dd6c8035edeadb", ["hermes-e2e"]],
  [
    "a65295651dc4f063a9426a5483db2a0dec4e5711cae5e1876ec6bbb46d9812e7",
    ["hermes-gpu-startup"],
  ],
  ["a22b9e7cb4464fac3b11ab6fbf97f03206857986751caa3df8b43737636c0f83", ["network-policy"]],
  [
    "8192ec63e62d8054db87229b6cea1462e6f104d67aa1a8b2898a4a699abed2e4",
    ["common-egress-agent"],
  ],
  ["4a495b13d05cc1662706dd54f72237d658a95fd6430a27f1d1657943f1709753", ["jetson-nvmap-gpu"]],
  ["c680bef1c896cf5b015134906748f55ac15d5db1ce7cd456c10a93c474d05851", ["cloud-onboard"]],
  [
    "1da697a3cff57841a9cc719a4e9bebd63ce08aa6f185d677fd9084cce1db7a2b",
    ["openclaw-plugin-runtime-exdev-release"],
  ],
  [
    "68a1a448256f320d39db9482b20f23f21a86be29a877149c460bf43f303772fb",
    ["openclaw-plugin-runtime-exdev"],
  ],
  [
    "9775c9363d99f11f54c34baf98c701ed1147206b76239f3ef6e41c52bdf5833d",
    ["openclaw-tui-chat-correlation"],
  ],
] as const;
const PRE_RESTORE_SEQUENCE_JOB_NAMES = PRE_RESTORE_SEQUENCE_CONTRACTS.flatMap(
  ([, jobNames]) => [...jobNames],
);
const PRE_RESTORE_SEQUENCE_SHA256_BY_JOB = new Map(
  PRE_RESTORE_SEQUENCE_CONTRACTS.flatMap(([sha256, jobNames]) =>
    jobNames.map((jobName) => [jobName, sha256] as const),
  ),
);

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

function workflowContentSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex");
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
    '[[ "$run_id" == "$GITHUB_RUN_ID" && "$run_attempt" == "$GITHUB_RUN_ATTEMPT" ]]',
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
      RUN_ATTEMPT: "${{ steps.identity.outputs.run_attempt }}",
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
    '[[ -f "$boundary_path" && ! -L "$boundary_path" && -s "$boundary_path" ]]',

    ".sourceRevision == $candidateSha",
    "candidate CLI build identity does not match the candidate commit SHA",
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
  if (job.needs !== CLI_ARTIFACT_PRODUCER_JOB) {
    errors.push(`${jobName} must depend directly on the CLI artifact producer`);
  }
  const candidateCheckoutIndexes = jobSteps.flatMap((step, index) =>
    workflowContentSha256(step) === CANDIDATE_CHECKOUT_STEP_CONTENT_SHA256 ? [index] : [],
  );
  if (candidateCheckoutIndexes.length !== 1) {
    errors.push(
      `${jobName} must use one candidate checkout with the required action, repository, ref, and credential settings`,
    );
  }
  const prepareIndex = jobSteps.findIndex((step) => step.uses === PREPARE_E2E_ACTION);
  const restoreSteps = jobSteps.filter(
    (step) => step.name === CLI_ARTIFACT_RESTORE_STEP || step.uses === CLI_ARTIFACT_RESTORE_ACTION,
  );
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
  const candidateCheckoutIndex = candidateCheckoutIndexes[0] ?? -1;
  if (candidateCheckoutIndex >= restoreIndex) {
    errors.push(`${jobName} must check out the candidate before CLI artifact restore`);
  }
  const expectedPreRestoreSequenceSha256 = PRE_RESTORE_SEQUENCE_SHA256_BY_JOB.get(jobName);
  if (
    !expectedPreRestoreSequenceSha256 ||
    workflowContentSha256(jobSteps.slice(0, restoreIndex)) !== expectedPreRestoreSequenceSha256
  ) {
    errors.push(`${jobName} steps before CLI artifact restore must match the required sequence`);
  }
  if (!(prepareIndex >= 0 && prepareIndex < restoreIndex)) {
    errors.push(`${jobName} must prepare before restoring the CLI artifact`);
  }
  if (prepareIndex >= 0 && restoreIndex !== prepareIndex + 1) {
    errors.push(`${jobName} must restore the CLI artifact in the step after workspace preparation`);
  }
}

export function validateCliArtifactWorkflowBoundary(
  workflow: WorkflowRecord,
  actionPath = DEFAULT_RESTORE_ACTION_PATH,
): string[] {
  const errors = validateCliArtifactRestoreAction(actionPath);
  const jobs = record(workflow.jobs);
  const producer = record(jobs[CLI_ARTIFACT_PRODUCER_JOB]);
  if (Object.keys(producer).length === 0) {
    errors.push(`workflow is missing CLI artifact producer ${CLI_ARTIFACT_PRODUCER_JOB}`);
    return errors;
  }
  validateProducer(errors, producer);

  const consumerJobNames = new Set<string>();
  for (const [jobName, value] of Object.entries(jobs)) {
    const job = record(value);
    const jobSteps = steps(job.steps);
    const usesPrepare = jobSteps.some((step) => step.uses === PREPARE_E2E_ACTION);
    const artifactSteps = jobSteps.filter(
      (step) =>
        step.name === CLI_ARTIFACT_RESTORE_STEP ||
        (typeof step.uses === "string" &&
          step.uses.startsWith("NVIDIA/NemoClaw/.github/actions/restore-e2e-cli-artifact@")),
    );
    const shouldConsume =
      usesPrepare &&
      jobName !== CLI_ARTIFACT_PRODUCER_JOB &&
      !PREPARE_E2E_NO_BUILD_JOBS.has(jobName) &&
      !PREPARE_E2E_TRUSTED_BUILD_JOBS.has(jobName);
    if (shouldConsume) {
      consumerJobNames.add(jobName);
      validateConsumer(errors, jobName, job, jobSteps);
    } else if (artifactSteps.length > 0) {
      errors.push(`${jobName} must not consume the shared CLI artifact`);
    }
  }

  if (PRE_RESTORE_SEQUENCE_SHA256_BY_JOB.size !== PRE_RESTORE_SEQUENCE_JOB_NAMES.length) {
    errors.push("pre-restore sequence contracts must name each CLI artifact consumer once");
  }
  for (const contractJobName of PRE_RESTORE_SEQUENCE_SHA256_BY_JOB.keys()) {
    if (!consumerJobNames.has(contractJobName)) {
      errors.push(
        `${contractJobName} pre-restore sequence contract must reference a current CLI artifact consumer`,
      );
    }
  }

  return errors;
}
