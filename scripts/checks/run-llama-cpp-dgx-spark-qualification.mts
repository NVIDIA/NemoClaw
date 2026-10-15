// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { startQualificationLoopbackRelay } from "./llama-cpp-qualification-relay.mts";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareDottedVersions } from "../../src/lib/domain/maintenance/upgrade.ts";
import {
  buildLlamaCppRequestGuardDockerArgv,
  consumeDockerLoopbackPublishAuthority,
  type DockerLoopbackPublishAuthority,
  qualifyDockerLoopbackPublishAuthority,
  type VerifiedLocalModelArtifact,
} from "../../src/lib/inference/llama-cpp/host-local-runtime.ts";
import {
  runLlamaCppDgxSparkProtocolQualification,
  validateChatCompletionResponse,
  validateModelsResponse,
} from "./llama-cpp-dgx-spark-protocol-qualification.mts";
import {
  LLAMA_CPP_DGX_SPARK_MODEL_PATH_PATTERN,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_IMAGE_REPOSITORY,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_KIND,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE,
  type LlamaCppDgxSparkExecutionPlan,
  parseLlamaCppDgxSparkExecutionPlan,
  createLlamaCppDgxSparkFailureDiagnostic,
  type LlamaCppDgxSparkFailurePhase,
  type LlamaCppDgxSparkFailureReason,
} from "./llama-cpp-dgx-spark-qualification-contract.mts";
import { runLlamaCppOpenClawAgentQualification } from "./llama-cpp-openclaw-agent-qualification.mts";
import { resolveManagedImageLocalInferenceRoute } from "./managed-image-protected-runtime-contract.ts";
import {
  runManagedImageOpenShellE2e,
  cleanupInterruptedManagedImageOpenShellE2e,
} from "./run-managed-image-openshell-e2e.ts";

export {
  startQualificationLoopbackRelay,
  qualifyDockerLoopbackPublishAuthority,
  validateChatCompletionResponse,
  validateModelsResponse,
};

const sha256Pattern = /^sha256:[0-9a-f]{64}$/u;
const gitShaPattern = /^[0-9a-f]{40}$/u;
const runIdPattern = /^[1-9][0-9]{0,19}$/u;
const runAttemptPattern = /^[1-9][0-9]{0,9}$/u;
const safePathPattern = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const registryImage =
  "docker.io/library/registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const registryOwnerLabel = "io.nvidia.nemoclaw.llama-cpp-qualification-owner";
const localImageRepository = LLAMA_CPP_DGX_SPARK_QUALIFICATION_IMAGE_REPOSITORY;
const expectedWorkflowRef = "NVIDIA/NemoClaw/.github/workflows/e2e.yaml@refs/heads/main";
const maximumPlanBytes = 1024 * 1024;
const maximumDockerfileBytes = 1024 * 1024;
const maximumModelBytes = 128 * 1024 * 1024 * 1024;
const relativeImageRoot = "managed-inference/images/llama-cpp";
const trustedRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const trustedImageRoot = path.join(trustedRepoRoot, relativeImageRoot);

type JsonRecord = Record<string, unknown>;

export type QualificationPlan = LlamaCppDgxSparkExecutionPlan;

export type QualificationInvocation = {
  candidateBase: string;
  candidateHead: string;
  candidateRoot: string;
  cleanupOnly: false;
  modelHostPath: string;
  output: string;
  planFile: string;
  planSha256: string;
  registryName: string;
  registryOwner: string;
  runAttempt: string;
  runId: string;
  workflowSha: string;
};

export type CleanupInvocation = {
  cleanupOnly: true;
  registryName: string;
  registryOwner: string;
  runAttempt: string;
  runId: string;
};

type TrustedEnvironment = Record<string, string | undefined>;

type RuntimeNames = {
  containerName: string;
  networkName: string;
  registryName: string;
  registryOwner: string;
  tempRoot: string;
};

type CleanupEvidence = {
  containerRemoved: boolean;
  keyFileRemoved: boolean;
  loopbackListenerClosed: boolean;
  networkRemoved: boolean;
  registryListenerClosed: boolean;
  registryRemoved: boolean;
  tempFilesRemoved: boolean;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

export function sha256Text(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function validateQualificationPlan(source: string, expectedHash: string): QualificationPlan {
  requiredString(expectedHash, "qualification plan digest", sha256Pattern);
  if (Buffer.byteLength(source) < 1 || Buffer.byteLength(source) > maximumPlanBytes) {
    throw new Error("qualification plan must be a bounded non-empty document");
  }
  if (sha256Text(source) !== expectedHash) {
    throw new Error("qualification plan digest mismatch");
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("qualification plan is not valid JSON");
  }
  if (JSON.stringify(value) !== source) {
    throw new Error("qualification plan must be canonical compact JSON");
  }
  return parseLlamaCppDgxSparkExecutionPlan(value, expectedHash);
}
function requiredAbsolutePath(value: unknown, name: string, pattern: RegExp): string {
  const validated = requiredString(value, name, pattern);
  if (validated.split(path.sep).some((segment) => segment === "." || segment === "..")) {
    throw new Error(`invalid ${name}`);
  }
  return validated;
}

function parseOptions(argv: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || options.has(name)) {
      throw new Error("invalid qualification command arguments");
    }
    options.set(name, value);
  }
  return options;
}

function requireTrustedEnvironment(
  environment: TrustedEnvironment,
  runId: string,
  runAttempt: string,
  workflowSha?: string,
): void {
  const actor = environment.GITHUB_ACTOR ?? "";
  if (
    environment.GITHUB_REPOSITORY !== "NVIDIA/NemoClaw" ||
    environment.GITHUB_REF !== "refs/heads/main" ||
    (environment.GITHUB_EVENT_NAME !== "push" &&
      environment.GITHUB_EVENT_NAME !== "workflow_dispatch") ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/u.test(actor) ||
    environment.GITHUB_RUN_ID !== runId ||
    environment.GITHUB_RUN_ATTEMPT !== runAttempt ||
    !/^[1-9][0-9]*$/u.test(environment.GITHUB_ACTOR_ID ?? "") ||
    (workflowSha !== undefined && environment.GITHUB_SHA !== workflowSha) ||
    environment.GITHUB_WORKFLOW_REF !== expectedWorkflowRef
  ) {
    throw new Error("qualification invocation does not match the trusted workflow identity");
  }
}

export function expectedRegistryOwner(runId: string, runAttempt: string): string {
  return `llama-cpp-dgx-spark-${runId}-${runAttempt}`;
}

export function expectedRegistryName(runId: string, runAttempt: string): string {
  return `nemoclaw-llama-cpp-${runId}-${runAttempt}`;
}

export function parseQualificationInvocation(
  argv: string[],
  environment: TrustedEnvironment = process.env,
): QualificationInvocation | CleanupInvocation {
  const cleanupOnly = argv[0] === "--cleanup-only";
  const options = parseOptions(cleanupOnly ? argv.slice(1) : argv);
  const required = cleanupOnly
    ? ["--registry-name", "--run-attempt", "--run-id"]
    : [
        "--base-sha",
        "--candidate-root",
        "--head-sha",
        "--model-host-path",
        "--output",
        "--plan",
        "--plan-sha256",
        "--registry-name",
        "--run-attempt",
        "--run-id",
        "--workflow-sha",
      ];
  if (JSON.stringify([...options.keys()].sort()) !== JSON.stringify([...required].sort())) {
    throw new Error("qualification command fields do not match the trusted contract");
  }
  const runId = requiredString(options.get("--run-id"), "run id", runIdPattern);
  const runAttempt = requiredString(options.get("--run-attempt"), "run attempt", runAttemptPattern);
  const registryOwner = expectedRegistryOwner(runId, runAttempt);
  const registryName = requiredString(
    options.get("--registry-name"),
    "registry name",
    /^nemoclaw-llama-cpp-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/u,
  );
  if (registryName !== expectedRegistryName(runId, runAttempt)) {
    throw new Error("registry ownership does not match this workflow run");
  }
  requireTrustedEnvironment(environment, runId, runAttempt);
  if (cleanupOnly)
    return {
      cleanupOnly: true,
      registryName,
      registryOwner,
      runAttempt,
      runId,
    };

  const workflowSha = requiredString(options.get("--workflow-sha"), "workflow SHA", gitShaPattern);
  requireTrustedEnvironment(environment, runId, runAttempt, workflowSha);
  const candidateHead = requiredString(options.get("--head-sha"), "candidate head", gitShaPattern);
  const candidateBase = requiredString(options.get("--base-sha"), "candidate base", gitShaPattern);
  if (candidateBase === candidateHead) throw new Error("candidate head must differ from its base");
  const candidateRoot = requiredAbsolutePath(
    options.get("--candidate-root"),
    "candidate root",
    safePathPattern,
  );
  const modelHostPath = requiredAbsolutePath(
    options.get("--model-host-path"),
    "model host path",
    LLAMA_CPP_DGX_SPARK_MODEL_PATH_PATTERN,
  );
  const planFile = requiredAbsolutePath(options.get("--plan"), "plan file", safePathPattern);
  const output = requiredAbsolutePath(options.get("--output"), "output path", safePathPattern);
  const planSha256 = requiredString(
    options.get("--plan-sha256"),
    "qualification plan digest",
    sha256Pattern,
  );
  return {
    candidateBase,
    candidateHead,
    candidateRoot,
    cleanupOnly: false,
    modelHostPath,
    output,
    planFile,
    planSha256,
    registryName,
    registryOwner,
    runAttempt,
    runId,
    workflowSha,
  };
}

export function buildCandidateImageArgv(
  plan: QualificationPlan,
  invocation: QualificationInvocation,
  metadataFile: string,
): string[] {
  const dockerfile = path.join(trustedImageRoot, "Dockerfile");
  const buildArguments = [
    `C_COMPILER=${plan.imageBuild.compiler.c}`,
    `CUDA_HOST_CXX_COMPILER=${plan.imageBuild.compiler.cudaHostCxx}`,
    `CXX_COMPILER=${plan.imageBuild.compiler.cxx}`,
    `CUDA_ARCHITECTURES=${plan.imageBuild.platform.cudaArchitectures}`,
    `CUDA_DEV_IMAGE=${plan.imageBuild.cuda.developmentBase}`,
    `CUDA_RUNTIME_IMAGE=${plan.imageBuild.cuda.runtimeBase}`,
    `GGML_BACKEND_DIR=${plan.imageBuild.backendDirectory}`,
    `LLAMA_CPP_ARCHIVE_SHA256=${plan.imageBuild.source.archiveSha256}`,
    `LLAMA_CPP_REVISION=${plan.imageBuild.source.revision}`,
    `NEMOCLAW_REVISION=${invocation.candidateHead}`,
    `REQUEST_GUARD_GO_ARCHIVE_SHA256=${plan.imageBuild.requestGuardToolchain.archiveSha256}`,
    `REQUEST_GUARD_GO_VERSION=${plan.imageBuild.requestGuardToolchain.version}`,
    `RUNTIME_GID=${plan.imageBuild.runtime.gid}`,
    `RUNTIME_UID=${plan.imageBuild.runtime.uid}`,
    `TARGETPLATFORM=${plan.imageBuild.platform.platform}`,
  ];
  return [
    "buildx",
    "build",
    "--file",
    dockerfile,
    "--platform",
    "linux/arm64",
    "--push",
    "--provenance=false",
    "--sbom=false",
    "--metadata-file",
    metadataFile,
    "--tag",
    `${localImageRepository}:${invocation.candidateHead}`,
    ...buildArguments.flatMap((argument) => ["--build-arg", argument]),
    trustedImageRoot,
  ];
}

export function buildServerContainerArgv(
  plan: QualificationPlan,
  options: {
    apiKeyHostPath: string;
    containerName: string;
    imageReference: string;
    model: VerifiedLocalModelArtifact;
    networkName: string;
    registryOwner: string;
    runtimeGid: number;
    runtimeUid: number;
  },
): string[] {
  if (plan.qualification.requestGuard !== "required") {
    throw new Error("llama.cpp qualification requires the declarative request guard");
  }
  const argv = buildLlamaCppRequestGuardDockerArgv(plan.recipe, {
    apiKeyHostPath: options.apiKeyHostPath,
    containerName: options.containerName,
    imageReference: options.imageReference,
    model: options.model,
    network: { isolation: "docker-internal", name: options.networkName },
    ownerLabel: { name: registryOwnerLabel, value: options.registryOwner },
    runtimeGid: options.runtimeGid,
    runtimeUid: options.runtimeUid,
  });
  // Upstream emits the GPU offload count only at trace verbosity.
  argv.splice(argv.indexOf(options.imageReference), 0, "--env", "LLAMA_ARG_LOG_VERBOSITY=4");
  return argv;
}

export function validateOpenClawQualificationImageLabels(
  source: string,
  expectedRevision: string,
): void {
  let labels: unknown;
  try {
    labels = JSON.parse(source) as unknown;
  } catch {
    throw new Error("OpenClaw qualification image labels are invalid");
  }
  if (
    !isRecord(labels) ||
    labels["io.nvidia.nemoclaw.agent"] !== "openclaw" ||
    labels["io.nvidia.nemoclaw.managed-image.contract"] !== "1" ||
    labels["io.nvidia.nemoclaw.managed-image.platform"] !== "linux/arm64" ||
    labels["org.opencontainers.image.source"] !== "https://github.com/NVIDIA/NemoClaw" ||
    labels["org.opencontainers.image.revision"] !== expectedRevision
  ) {
    throw new Error("OpenClaw qualification image does not match the declarative identity");
  }
}

export function validateStartupLog(log: string): {
  offloadedLayers: number;
  totalLayers: number;
} {
  if (Buffer.byteLength(log) < 1 || Buffer.byteLength(log) > 16 * 1024 * 1024) {
    throw new Error("startup evidence is missing or exceeds the bounded log size");
  }
  if (
    /no usable GPU|gpu-layers[^\n]*ignored|compiled without[^\n]*GPU|CPU fallback|fallback to CPU|falling back to CPU/iu.test(
      log,
    )
  ) {
    throw new Error("startup evidence reports a rejected GPU or CPU fallback warning");
  }
  const matches = [
    ...log.matchAll(/offloaded\s+([1-9][0-9]*)\/([1-9][0-9]*)\s+layers?\s+to\s+GPU/giu),
  ];
  if (matches.length < 1)
    throw new Error("startup evidence is missing the pinned GPU offload line");
  const counts = matches.map((match) => ({
    offloadedLayers: Number.parseInt(match[1] ?? "0", 10),
    totalLayers: Number.parseInt(match[2] ?? "0", 10),
  }));
  if (counts.some(({ offloadedLayers, totalLayers }) => offloadedLayers !== totalLayers)) {
    throw new Error("startup evidence reports partial GPU offload");
  }
  const uniqueCounts = new Set(counts.map(({ offloadedLayers }) => offloadedLayers));
  if (uniqueCounts.size !== 1)
    throw new Error("startup evidence has inconsistent GPU offload counts");
  return counts[0] as { offloadedLayers: number; totalLayers: number };
}

export function validateRuntimeLogRedaction(
  log: string,
  forbiddenValues: readonly string[],
): { readonly ok: true } {
  if (Buffer.byteLength(log) < 1 || Buffer.byteLength(log) > 16 * 1024 * 1024) {
    throw new Error("runtime log evidence is missing or exceeds the bounded log size");
  }
  if (
    forbiddenValues.length < 1 ||
    forbiddenValues.some((value) => value.length < 8 || log.includes(value))
  ) {
    throw new Error("runtime log evidence contains a credential, path, prompt, or response value");
  }
  return { ok: true };
}

export function buildRuntimeLogForbiddenValues(
  plan: QualificationPlan,
  invocation: QualificationInvocation,
  apiKey: string,
  authorization: string,
): readonly string[] {
  const agentPlan = plan.qualification.agentQualification;
  const rejectedAuthorization = `${authorization.slice(0, -1)}${authorization.endsWith("0") ? "1" : "0"}`;
  return [
    apiKey,
    authorization,
    rejectedAuthorization,
    invocation.modelHostPath,
    `/models/${plan.recipe.model.file.path}`,
    "This request must be rejected.",
    "Return one short readiness token.",
    "Reply with exactly: ready",
    "Reply with one token.",
    "Count upward without stopping.",
    "Report the requested qualification status.",
    "Use the available tool to get the weather in Seattle.",
    JSON.stringify({ conditions: "clear", temperature_c: 21 }),
    JSON.stringify({ location: "Seattle" }),
    agentPlan.prompts.normal,
    agentPlan.prompts.tool,
    agentPlan.prompts.continuation,
    agentPlan.fixture.value,
  ];
}

export function parseNvidiaSmi(
  output: string,
  minimumDriverVersion: string,
): { count: 1; driverVersion: string; name: "NVIDIA GB10" } {
  const lines = output
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) throw new Error("qualification requires exactly one visible NVIDIA GPU");
  const match = /^(NVIDIA GB10)\s*,\s*([0-9]{3}\.[0-9]{2,3}\.[0-9]{2})$/u.exec(lines[0] ?? "");
  if (!match) throw new Error("qualification host is not the expected NVIDIA GB10 profile");
  const driverVersion = match[2] as string;
  if (compareDottedVersions(driverVersion, minimumDriverVersion) < 0) {
    throw new Error("NVIDIA driver is below the qualification minimum");
  }
  return { count: 1, driverVersion, name: "NVIDIA GB10" };
}

export function parseQualificationBridgeGateway(raw: string, expectedName: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("qualification managed bridge inspection is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("qualification managed bridge inspection is invalid");
  const network = parsed as Record<string, unknown>;
  const ipam = network.IPAM as Record<string, unknown> | undefined;
  const configurations = ipam?.Config;
  const entry = Array.isArray(configurations) ? configurations[0] : null;
  const gateway =
    entry && typeof entry === "object" ? (entry as Record<string, unknown>).Gateway : null;
  if (
    network.Name !== expectedName ||
    network.Driver !== "bridge" ||
    network.Internal !== false ||
    !Array.isArray(configurations) ||
    configurations.length !== 1 ||
    typeof gateway !== "string" ||
    net.isIP(gateway) !== 4 ||
    !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(gateway)
  ) {
    throw new Error("qualification managed bridge has no exact private IPv4 gateway");
  }
  return gateway;
}

class QualificationCommandError extends Error {
  readonly exitCode: number | null;
  constructor(status: number | null) {
    super("qualification command failed");
    this.exitCode = status !== null && status > 0 && status <= 255 ? status : null;
  }
}

const FAILURE_REASONS: Record<string, LlamaCppDgxSparkFailureReason> = {
  "qualification requires docker": "missing-docker",
  "qualification requires git": "missing-git",
  "DGX Spark qualification requires a Linux ARM64 host": "unsupported-host",
  "qualification plan digest mismatch": "plan-digest-mismatch",
  "model file digest does not match the qualification plan": "model-digest-mismatch",
  "model file size does not match the bounded qualification plan": "model-size-mismatch",
  "qualification host is not the expected NVIDIA GB10 profile": "wrong-gpu",
  "NVIDIA driver is below the qualification minimum": "driver-too-old",
  "startup evidence reports partial GPU offload": "partial-offload",
  "model server did not become healthy within the qualification timeout": "readiness-timeout",
  "qualification cleanup is incomplete": "cleanup-incomplete",
};

function runCommand(
  command: string,
  args: string[],
  options: { capture?: boolean; includeStderr?: boolean; maximumBytes?: number } = {},
): Buffer {
  const capture = options.capture ?? true;
  const result = spawnSync(command, args, {
    encoding: null,
    maxBuffer: options.maximumBytes ?? 16 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "ignore"],
  });
  if (result.error || result.status !== 0) {
    throw new QualificationCommandError(result.status);
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
  return options.includeStderr ? Buffer.concat([stdout, stderr]) : stdout;
}

function commandSucceeds(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

function readBoundedRegularFileBytes(file: string, maximumBytes: number): Buffer {
  if (fs.realpathSync(file) !== file) {
    throw new Error("trusted input path must not use symlinks");
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const status = fs.fstatSync(descriptor);
    if (!status.isFile() || status.size < 1 || status.size > maximumBytes) {
      throw new Error("trusted input must be a bounded regular file");
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readBoundedRegularFile(file: string, maximumBytes: number): string {
  return readBoundedRegularFileBytes(file, maximumBytes).toString("utf8");
}

export function validateCandidateDockerfile(candidateRoot: string): void {
  const candidateDockerfile = path.join(candidateRoot, relativeImageRoot, "Dockerfile");
  const trustedDockerfile = path.join(trustedImageRoot, "Dockerfile");
  const candidateSource = readBoundedRegularFileBytes(candidateDockerfile, maximumDockerfileBytes);
  const trustedSource = readBoundedRegularFileBytes(trustedDockerfile, maximumDockerfileBytes);
  if (!candidateSource.equals(trustedSource)) {
    throw new Error("candidate Dockerfile must byte-match the trusted main Dockerfile");
  }
}

function validateCandidateCheckout(invocation: QualificationInvocation): string {
  const candidateRootStatus = fs.lstatSync(invocation.candidateRoot);
  if (!candidateRootStatus.isDirectory() || candidateRootStatus.isSymbolicLink()) {
    throw new Error("candidate root must be a real directory");
  }
  const root = fs.realpathSync(invocation.candidateRoot);
  if (root !== invocation.candidateRoot) throw new Error("candidate root must not use symlinks");
  const head = runCommand("git", ["-C", root, "rev-parse", "HEAD"]).toString("utf8").trim();
  if (head !== invocation.candidateHead)
    throw new Error("candidate checkout does not match its head");
  runCommand("git", ["-C", root, "cat-file", "-e", `${invocation.candidateBase}^{commit}`]);
  runCommand("git", [
    "-C",
    root,
    "merge-base",
    "--is-ancestor",
    invocation.candidateBase,
    invocation.candidateHead,
  ]);
  const status = runCommand("git", [
    "-C",
    root,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    relativeImageRoot,
  ])
    .toString("utf8")
    .trim();
  if (status) throw new Error("candidate image source must match the exact committed head");
  validateCandidateDockerfile(root);
  return root;
}

export function hashModelFile(
  modelHostPath: string,
  plan: QualificationPlan,
): VerifiedLocalModelArtifact {
  if (path.basename(modelHostPath) !== plan.recipe.model.file.path) {
    throw new Error("model file name does not match the qualification plan");
  }
  const realPath = fs.realpathSync(modelHostPath);
  if (realPath !== modelHostPath) throw new Error("model file path must not use symlinks");
  const descriptor = fs.openSync(modelHostPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const expectedSize = BigInt(plan.recipe.model.file.sizeBytes);
    if (
      !before.isFile() ||
      before.size !== expectedSize ||
      before.size < 1n ||
      before.size > BigInt(maximumModelBytes)
    ) {
      throw new Error("model file size does not match the bounded qualification plan");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    const sizeBytes = Number(before.size);
    let position = 0;
    while (position < sizeBytes) {
      const read = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, sizeBytes - position),
        position,
      );
      if (read < 1) throw new Error("model file changed during verification");
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("model file changed during verification");
    }
    const digest = `sha256:${hash.digest("hex")}`;
    if (digest !== plan.recipe.model.file.digest) {
      throw new Error("model file digest does not match the qualification plan");
    }
    return {
      digest,
      filesystemIdentity: {
        ctimeNs: after.ctimeNs,
        dev: after.dev,
        ino: after.ino,
        mtimeNs: after.mtimeNs,
        size: after.size,
      },
      hostPath: modelHostPath,
      sizeBytes,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

async function tcpOpen(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function waitForRegistry(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:5000/v2/", {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      // The bounded retry loop owns transient startup failures.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    "isolated registry did not return a successful /v2/ response before the retry limit",
  );
}

function dockerInspectionOwner(
  result: SpawnSyncReturns<string>,
  name: string,
  kind: "container" | "network",
): string | null {
  if (!result.error && result.status === 0) return result.stdout.trim();
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const absent = new RegExp(
    `^(?:Error(?: response from daemon)?:\\s*)?(?:No such (?:${kind}|object): ${escapedName}${kind === "network" ? `|network ${escapedName} not found` : ""})$`,
    "iu",
  );
  if (!result.error && result.status === 1 && absent.test(String(result.stderr ?? "").trim()))
    return null;
  throw new QualificationCommandError(result.status);
}

function dockerContainerOwner(name: string): string | null {
  const result = spawnSync(
    "docker",
    ["container", "inspect", "--format", `{{index .Config.Labels "${registryOwnerLabel}"}}`, name],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return dockerInspectionOwner(result, name, "container");
}

function dockerNetworkOwner(name: string): string | null {
  const result = spawnSync(
    "docker",
    ["network", "inspect", "--format", `{{index .Labels "${registryOwnerLabel}"}}`, name],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return dockerInspectionOwner(result, name, "network");
}

function runtimeNames(
  invocation: Pick<CleanupInvocation, "registryName" | "registryOwner" | "runAttempt" | "runId">,
  environment: TrustedEnvironment,
): RuntimeNames {
  const runnerTemp = environment.RUNNER_TEMP;
  if (!runnerTemp || !path.isAbsolute(runnerTemp)) {
    throw new Error("RUNNER_TEMP must be an absolute trusted runner directory");
  }
  const tempStatus = fs.lstatSync(runnerTemp);
  if (!tempStatus.isDirectory() || tempStatus.isSymbolicLink()) {
    throw new Error("RUNNER_TEMP must be a real directory");
  }
  const realRunnerTemp = fs.realpathSync(runnerTemp);
  return {
    containerName: `nemoclaw-llama-cpp-server-${invocation.runId}-${invocation.runAttempt}`,
    networkName: `nemoclaw-llama-cpp-network-${invocation.runId}-${invocation.runAttempt}`,
    registryName: invocation.registryName,
    registryOwner: invocation.registryOwner,
    tempRoot: path.join(realRunnerTemp, invocation.registryOwner),
  };
}

async function cleanupOwnedRuntime(
  names: RuntimeNames,
  loopbackPort?: number,
  managedPlan?: { source: string; digest: string },
): Promise<CleanupEvidence> {
  let managedRecoveryFailure: unknown;
  try {
    await cleanupInterruptedManagedAgent(names, managedPlan);
  } catch (error) {
    managedRecoveryFailure = error;
  }
  const registryWasOwned = dockerContainerOwner(names.registryName) === names.registryOwner;
  for (const name of [names.containerName, names.registryName]) {
    const owner = dockerContainerOwner(name);
    if (owner !== null && owner !== names.registryOwner) {
      throw new Error("refusing to remove a Docker container not owned by this qualification run");
    }
    if (owner === names.registryOwner) runCommand("docker", ["rm", "--force", name]);
  }
  const networkOwner = dockerNetworkOwner(names.networkName);
  if (networkOwner !== null && networkOwner !== names.registryOwner) {
    throw new Error("refusing to remove a Docker network not owned by this qualification run");
  }
  if (networkOwner === names.registryOwner)
    runCommand("docker", ["network", "rm", names.networkName]);
  const keyFile = path.join(names.tempRoot, "api-key");
  if (managedRecoveryFailure) {
    fs.rmSync(keyFile, { force: true });
    throw managedRecoveryFailure;
  }
  fs.rmSync(names.tempRoot, { force: true, recursive: true });
  const evidence = {
    containerRemoved: dockerContainerOwner(names.containerName) === null,
    keyFileRemoved: !fs.existsSync(keyFile),
    loopbackListenerClosed: loopbackPort === undefined || !(await tcpOpen(loopbackPort)),
    networkRemoved: dockerNetworkOwner(names.networkName) === null,
    registryListenerClosed: !registryWasOwned || !(await tcpOpen(5000)),
    registryRemoved: dockerContainerOwner(names.registryName) === null,
    tempFilesRemoved: !fs.existsSync(names.tempRoot),
  };
  if (Object.values(evidence).includes(false))
    throw new Error("qualification cleanup is incomplete");
  return evidence;
}

async function cleanupInterruptedManagedAgent(
  names: RuntimeNames,
  boundPlan?: { source: string; digest: string },
): Promise<void> {
  const stateDir = path.join(names.tempRoot, "managed-openshell");
  if (!fs.existsSync(stateDir)) return;
  if (!boundPlan) throw new Error("managed recovery requires a bound qualification plan");
  const plan = validateQualificationPlan(boundPlan.source, boundPlan.digest);
  const agent = plan.qualification.agentQualification;
  if (agent.execution !== "enabled")
    throw new Error("managed recovery requires enabled qualification");
  await cleanupInterruptedManagedImageOpenShellE2e(
    {
      agent: agent.agent,
      image: agent.image.reference,
      localProvider: "llama-cpp",
      model: plan.recipe.model.servedName,
      sandbox: agent.sandbox.name,
    },
    {
      owner: names.registryOwner,
      stateDir,
      networkName: `nemoclaw-managed-${names.registryOwner}`,
    },
  );
}

async function removeOwnedRegistry(names: RuntimeNames): Promise<void> {
  const owner = dockerContainerOwner(names.registryName);
  if (owner !== names.registryOwner) {
    throw new Error("refusing to remove a registry not owned by this qualification run");
  }
  runCommand("docker", ["rm", "--force", names.registryName]);
  if (dockerContainerOwner(names.registryName) !== null || (await tcpOpen(5000))) {
    throw new Error("isolated registry was not removed before model launch");
  }
}

function startRegistry(names: RuntimeNames): void {
  if (dockerContainerOwner(names.registryName) !== null) {
    throw new Error("isolated registry name is already in use");
  }
  consumeDockerLoopbackPublishAuthority(qualifyLiveDockerLoopbackPublishAuthority());
  runCommand(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      names.registryName,
      "--label",
      `${registryOwnerLabel}=${names.registryOwner}`,
      "--publish",
      "127.0.0.1:5000:5000",
      registryImage,
    ],
    { capture: false },
  );
}

function qualifyLiveDockerLoopbackPublishAuthority(): DockerLoopbackPublishAuthority {
  return qualifyDockerLoopbackPublishAuthority(
    runCommand("docker", ["version", "--format", "{{.Server.Version}}"]).toString("utf8"),
  );
}

function inspectBuiltImage(
  plan: QualificationPlan,
  invocation: QualificationInvocation,
  metadataFile: string,
): { digest: string; imageId: string; reference: string } {
  const metadata = JSON.parse(readBoundedRegularFile(metadataFile, maximumPlanBytes)) as unknown;
  if (!isRecord(metadata)) throw new Error("build metadata is malformed");
  const digest = requiredString(
    metadata["containerimage.digest"],
    "candidate digest",
    sha256Pattern,
  );
  const reference = `${localImageRepository}@${digest}`;
  const raw = runCommand("docker", ["buildx", "imagetools", "inspect", reference, "--raw"], {
    maximumBytes: 4 * 1024 * 1024,
  });
  if (sha256Text(raw) !== digest)
    throw new Error("candidate manifest bytes do not match its digest");
  runCommand("docker", ["pull", "--platform", "linux/arm64", reference], {
    capture: false,
  });
  const inspected = JSON.parse(
    runCommand("docker", ["image", "inspect", reference]).toString("utf8"),
  ) as unknown;
  if (!Array.isArray(inspected) || inspected.length !== 1 || !isRecord(inspected[0])) {
    throw new Error("candidate image inspect did not return one image");
  }
  const image = inspected[0];
  const imageId = requiredString(image.Id, "candidate image id", sha256Pattern);
  if (!isRecord(image.Config) || !isRecord(image.Config.Labels)) {
    throw new Error("candidate image configuration is malformed");
  }
  const labels = image.Config.Labels;
  if (
    image.Os !== "linux" ||
    image.Architecture !== "arm64" ||
    image.Config.User !== `${plan.imageBuild.runtime.uid}:${plan.imageBuild.runtime.gid}` ||
    JSON.stringify(image.Config.Entrypoint) !== JSON.stringify(["/usr/local/bin/llama-server"]) ||
    labels["org.opencontainers.image.revision"] !== invocation.candidateHead ||
    labels["io.nvidia.nemoclaw.inference-server.contract"] !== "1" ||
    labels["io.nvidia.nemoclaw.inference-server.component"] !== "llama.cpp" ||
    labels["io.nvidia.nemoclaw.inference-server.platform"] !== "linux/arm64" ||
    labels["io.nvidia.nemoclaw.inference-server.upstream.repository"] !==
      "https://github.com/ggml-org/llama.cpp" ||
    labels["io.nvidia.nemoclaw.inference-server.upstream.revision"] !==
      plan.imageBuild.source.revision ||
    labels["io.nvidia.nemoclaw.inference-server.upstream.archive-sha256"] !==
      plan.imageBuild.source.archiveSha256 ||
    labels["io.nvidia.nemoclaw.inference-server.cuda.development-base"] !==
      plan.imageBuild.cuda.developmentBase ||
    labels["io.nvidia.nemoclaw.inference-server.cuda.runtime-base"] !==
      plan.imageBuild.cuda.runtimeBase ||
    labels["io.nvidia.nemoclaw.inference-server.cuda.architectures"] !==
      plan.imageBuild.platform.cudaArchitectures
  ) {
    throw new Error("candidate image identity does not match the qualification plan");
  }
  return { digest, imageId, reference };
}

export function resolveRequestGuardAddress(
  names: Pick<RuntimeNames, "containerName" | "networkName" | "registryOwner">,
): string {
  if (
    dockerContainerOwner(names.containerName) !== names.registryOwner ||
    dockerNetworkOwner(names.networkName) !== names.registryOwner
  ) {
    throw new Error("qualification relay requires the owned container and network");
  }
  const network = JSON.parse(
    runCommand("docker", ["network", "inspect", names.networkName]).toString("utf8"),
  )[0];
  const container = JSON.parse(
    runCommand("docker", ["inspect", names.containerName]).toString("utf8"),
  )[0];
  const endpoints = container.NetworkSettings.Networks;
  const endpoint = endpoints[names.networkName];
  if (
    network.Internal !== true ||
    !container.State.Running ||
    Object.keys(endpoints).length !== 1 ||
    endpoint?.NetworkID !== network.Id ||
    net.isIP(endpoint?.IPAddress ?? "") !== 4
  ) {
    throw new Error("qualification relay requires one running container on its internal network");
  }
  return endpoint.IPAddress;
}

async function waitForHealth(port: number, timeoutSeconds: number): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) return;
    } catch {
      // The bounded readiness window owns transient model-load failures.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("model server did not become healthy within the qualification timeout");
}

function writeReceipt(output: string, receipt: unknown, tempRoot: string): void {
  if (output === tempRoot || output.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error("qualification receipt must not be written inside transient state");
  }
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { mode: 0o700, recursive: true });
  const parentStatus = fs.lstatSync(parent);
  if (
    !parentStatus.isDirectory() ||
    parentStatus.isSymbolicLink() ||
    fs.realpathSync(parent) !== parent
  ) {
    throw new Error("qualification receipt parent must be a real directory");
  }
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) {
    throw new Error("qualification receipt path must not be a symlink");
  }
  const temporary = `${output}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, output);
}

type QualificationProgress = { phase: LlamaCppDgxSparkFailurePhase; cleanupComplete: boolean };

export class QualificationFailureError extends Error {
  readonly diagnostic: ReturnType<typeof createLlamaCppDgxSparkFailureDiagnostic>;
  constructor(diagnostic: ReturnType<typeof createLlamaCppDgxSparkFailureDiagnostic>) {
    super(
      `DGX Spark qualification failed at ${diagnostic.phase} for ${diagnostic.owner}: ${diagnostic.reason}${diagnostic.exitCode === null ? "" : ` (exit ${diagnostic.exitCode})`}. ${diagnostic.recovery}`,
    );
    this.diagnostic = diagnostic;
  }
}

export async function runQualification(
  invocation: QualificationInvocation,
  environment: TrustedEnvironment,
): Promise<void> {
  const progress: QualificationProgress = { phase: "prerequisites", cleanupComplete: false };
  try {
    await runQualificationCore(invocation, environment, progress);
  } catch (error) {
    const diagnostic = createLlamaCppDgxSparkFailureDiagnostic(
      {
        baseSha: invocation.candidateBase,
        headSha: invocation.candidateHead,
        workflowSha: invocation.workflowSha,
        runId: Number(invocation.runId),
        runAttempt: Number(invocation.runAttempt),
      },
      invocation.planSha256,
      progress.phase,
      progress.cleanupComplete,
      error instanceof QualificationCommandError
        ? "command-failed"
        : error instanceof Error && Object.hasOwn(FAILURE_REASONS, error.message)
          ? FAILURE_REASONS[error.message]
          : "unclassified",
      error instanceof QualificationCommandError ? error.exitCode : null,
    );
    try {
      writeReceipt(
        path.join(path.dirname(invocation.output), "failure.json"),
        diagnostic,
        path.resolve(
          environment.RUNNER_TEMP ?? path.dirname(invocation.output),
          invocation.registryOwner,
        ),
      );
    } catch {
      process.stderr.write("Spark diagnostic artifact could not be retained.\n");
    }
    throw new QualificationFailureError(diagnostic);
  }
}

async function runQualificationCore(
  invocation: QualificationInvocation,
  environment: TrustedEnvironment,
  progress: QualificationProgress,
): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "arm64") {
    throw new Error("DGX Spark qualification requires a Linux ARM64 host");
  }
  for (const command of ["docker", "git"]) {
    if (!commandSucceeds(command, ["--version"]))
      throw new Error(`qualification requires ${command}`);
  }
  progress.phase = "candidate";
  validateCandidateCheckout(invocation);
  progress.phase = "plan";
  const planSource = readBoundedRegularFile(invocation.planFile, maximumPlanBytes);
  const plan = validateQualificationPlan(planSource, invocation.planSha256);
  progress.phase = "prerequisites";
  const names = runtimeNames(invocation, environment);
  progress.phase = "credentials";
  if (fs.existsSync(names.tempRoot)) fs.rmSync(names.tempRoot, { force: true, recursive: true });
  fs.mkdirSync(names.tempRoot, { mode: 0o700 });
  const metadataFile = path.join(names.tempRoot, "build-metadata.json");
  const apiKeyHostPath = path.join(names.tempRoot, "api-key");
  let loopbackPort: number | undefined;
  let relay: Awaited<ReturnType<typeof startQualificationLoopbackRelay>> | undefined;
  let bridgeRelay: Awaited<ReturnType<typeof startQualificationLoopbackRelay>> | undefined;
  let successReceipt: JsonRecord | undefined;
  let failure: unknown;
  let failurePhase: LlamaCppDgxSparkFailurePhase | undefined;
  let cleanupEvidence: CleanupEvidence | undefined;
  try {
    progress.phase = "registry";
    if (await tcpOpen(5000)) throw new Error("refusing to reuse an existing localhost registry");
    if (
      plan.qualification.agentQualification.execution === "enabled" &&
      (await tcpOpen(plan.recipe.serve.port))
    ) {
      throw new Error("refusing to reuse the declarative llama.cpp agent qualification port");
    }
    startRegistry(names);
    await waitForRegistry();
    progress.phase = "image-build";
    runCommand("docker", buildCandidateImageArgv(plan, invocation, metadataFile), {
      capture: false,
    });
    progress.phase = "image-identity";
    const image = inspectBuiltImage(plan, invocation, metadataFile);
    progress.phase = "registry";
    await removeOwnedRegistry(names);
    fs.rmSync(names.tempRoot, { force: true, recursive: true });
    fs.mkdirSync(names.tempRoot, { mode: 0o700 });
    progress.phase = "model";
    const model = hashModelFile(invocation.modelHostPath, plan);
    progress.phase = "credentials";
    const apiKey = randomBytes(32).toString("hex");
    fs.writeFileSync(apiKeyHostPath, apiKey, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const hostUid = process.getuid?.();
    const hostGid = process.getgid?.();
    if (hostUid === undefined || hostGid === undefined) {
      throw new Error("qualification requires a POSIX runtime identity");
    }
    if (hostUid !== 0 && hostGid === 0) {
      throw new Error("qualification requires a non-root POSIX group identity");
    }
    const runtimeUid = hostUid === 0 ? plan.imageBuild.runtime.uid : hostUid;
    const runtimeGid = hostUid === 0 ? plan.imageBuild.runtime.gid : hostGid;
    if (hostUid === 0) fs.chownSync(apiKeyHostPath, runtimeUid, runtimeGid);
    const apiKeyStatus = fs.statSync(apiKeyHostPath);
    if (
      (apiKeyStatus.mode & 0o777) !== 0o600 ||
      apiKeyStatus.uid !== runtimeUid ||
      apiKeyStatus.gid !== runtimeGid ||
      runtimeUid < 1
    ) {
      throw new Error("API key file permissions are not mode 0600");
    }
    progress.phase = "network";
    runCommand("docker", [
      "network",
      "create",
      "--internal",
      "--label",
      `${registryOwnerLabel}=${names.registryOwner}`,
      names.networkName,
    ]);
    progress.phase = "server";
    runCommand(
      "docker",
      buildServerContainerArgv(plan, {
        apiKeyHostPath,
        containerName: names.containerName,
        imageReference: image.reference,
        model,
        networkName: names.networkName,
        registryOwner: names.registryOwner,
        runtimeGid,
        runtimeUid,
      }),
      { capture: false },
    );
    relay = await startQualificationLoopbackRelay(
      resolveRequestGuardAddress(names),
      plan.recipe.serve.port,
      plan.recipe.serve.limits.requestTimeoutSeconds,
      plan.qualification.agentQualification.execution === "enabled" ? plan.recipe.serve.port : 0,
    );
    loopbackPort = relay.port;
    progress.phase = "gpu";
    const smi = parseNvidiaSmi(
      runCommand("docker", [
        "exec",
        names.containerName,
        "nvidia-smi",
        "--query-gpu=name,driver_version",
        "--format=csv,noheader,nounits",
      ]).toString("utf8"),
      plan.recipe.runtime.cuda.minimumDriverVersion,
    );
    progress.phase = "readiness";
    await waitForHealth(loopbackPort, plan.recipe.readiness.timeoutSeconds);
    progress.phase = "gpu";
    const offload = validateStartupLog(
      runCommand("docker", ["logs", "--tail", "20000", names.containerName], {
        includeStderr: true,
        maximumBytes: 16 * 1024 * 1024,
      }).toString("utf8"),
    );
    const authorization = `Bearer ${apiKey}`;
    const runtimeLogStart = new Date().toISOString();
    progress.phase = "protocol";
    const probes = await runLlamaCppDgxSparkProtocolQualification({
      authorization,
      baseUrl: `http://127.0.0.1:${loopbackPort}`,
      plan,
    });
    let agentQualification: JsonRecord = { execution: "disabled" };
    const agentPlan = plan.qualification.agentQualification;
    if (agentPlan.execution === "enabled") {
      progress.phase = "agent";
      if (loopbackPort !== plan.recipe.serve.port) {
        throw new Error("agent qualification requires the declarative llama.cpp loopback port");
      }
      runCommand(
        "docker",
        ["pull", "--platform", plan.imageBuild.platform.platform, agentPlan.image.reference],
        { capture: false },
      );
      validateOpenClawQualificationImageLabels(
        runCommand("docker", [
          "image",
          "inspect",
          "--format",
          "{{json .Config.Labels}}",
          agentPlan.image.reference,
        ]).toString("utf8"),
        agentPlan.image.sourceRevision,
      );
      const route = resolveManagedImageLocalInferenceRoute("llama-cpp");
      if (
        route.providerName !== agentPlan.route.provider ||
        route.defaultBaseUrl !== agentPlan.route.upstreamBaseUrl
      ) {
        throw new Error("managed OpenClaw route does not match the declarative qualification");
      }
      const credentialName = "NEMOCLAW_LLAMACPP_LOCAL_TOKEN";
      const baseUrlEnvironmentName = "NEMOCLAW_E2E_LOCAL_INFERENCE_BASE_URL";
      const priorCredential = process.env[credentialName];
      const priorBaseUrl = process.env[baseUrlEnvironmentName];
      process.env[credentialName] = apiKey;
      process.env[baseUrlEnvironmentName] = agentPlan.route.upstreamBaseUrl;
      try {
        const managedResult = await runManagedImageOpenShellE2e(
          {
            agent: agentPlan.agent,
            image: agentPlan.image.reference,
            localProvider: "llama-cpp",
            model: plan.recipe.model.servedName,
            sandbox: agentPlan.sandbox.name,
          },
          async (context) => {
            const managedNetworkName = `nemoclaw-managed-${names.registryOwner}`;
            const gatewayAddress = parseQualificationBridgeGateway(
              runCommand(
                "docker",
                ["network", "inspect", "--format", "{{json .}}", managedNetworkName],
                { maximumBytes: 64 * 1024 },
              ).toString("utf8"),
              managedNetworkName,
            );
            bridgeRelay = await startQualificationLoopbackRelay(
              resolveRequestGuardAddress(names),
              plan.recipe.serve.port,
              plan.recipe.serve.limits.requestTimeoutSeconds,
              plan.recipe.serve.port,
              gatewayAddress,
            );
            return runLlamaCppOpenClawAgentQualification(agentPlan, context);
          },
          {
            owner: names.registryOwner,
            stateDir: path.join(names.tempRoot, "managed-openshell"),
            networkName: `nemoclaw-managed-${names.registryOwner}`,
          },
          plan.recipe.serve.limits.maxOutputTokens,
        );
        if (!managedResult.probeEvidence) {
          throw new Error("OpenClaw qualification did not return bounded evidence");
        }
        agentQualification = {
          agent: agentPlan.agent,
          cleanup: managedResult.cleanup,
          execution: "enabled",
          image: agentPlan.image,
          model: {
            chatTemplate: plan.recipe.serve.chatTemplate,
            id: plan.recipe.model.id,
            quantization: plan.recipe.model.file.quantization,
            servedName: plan.recipe.model.servedName,
          },
          platform: plan.imageBuild.platform.platform,
          probes: managedResult.probeEvidence,
          route: agentPlan.route,
          runtimeProvider: agentPlan.runtimeProvider,
        };
      } finally {
        if (priorCredential === undefined) delete process.env[credentialName];
        else process.env[credentialName] = priorCredential;
        if (priorBaseUrl === undefined) delete process.env[baseUrlEnvironmentName];
        else process.env[baseUrlEnvironmentName] = priorBaseUrl;
      }
    }
    progress.phase = "redaction";
    const logRedaction = validateRuntimeLogRedaction(
      runCommand(
        "docker",
        ["logs", "--since", runtimeLogStart, "--tail", "20000", names.containerName],
        {
          includeStderr: true,
          maximumBytes: 16 * 1024 * 1024,
        },
      ).toString("utf8"),
      buildRuntimeLogForbiddenValues(plan, invocation, apiKey, authorization),
    );
    successReceipt = {
      agentQualification,
      baseSha: invocation.candidateBase,
      headSha: invocation.candidateHead,
      kind: LLAMA_CPP_DGX_SPARK_QUALIFICATION_KIND,
      repository: "NVIDIA/NemoClaw",
      run: {
        attempt: Number.parseInt(invocation.runAttempt, 10),
        id: Number.parseInt(invocation.runId, 10),
      },
      workflowSha: invocation.workflowSha,
      image: {
        digest: image.digest,
        platform: "linux/arm64",
        reference: image.reference,
        sourceRevision: plan.imageBuild.source.revision,
      },
      model: {
        digest: model.digest,
        id: plan.recipe.model.id,
      },
      host: {
        architecture: "arm64",
        driverVersion: smi.driverVersion,
        gpuName: smi.name,
        profile: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE,
      },
      execution: {
        cpuFallback: false,
        cpuWarning: false,
        fullOffload: true,
        ...offload,
      },
      probes: { ...probes, logRedaction },
    };
  } catch (error) {
    failure = error;
    failurePhase = progress.phase;
  } finally {
    progress.phase = "cleanup";
    try {
      await bridgeRelay?.close();
    } catch (cleanupError) {
      failure ??= cleanupError;
    }
    try {
      await relay?.close();
    } catch (cleanupError) {
      failure ??= cleanupError;
    }
    try {
      cleanupEvidence = await cleanupOwnedRuntime(names, loopbackPort, {
        source: planSource,
        digest: invocation.planSha256,
      });
      progress.cleanupComplete = true;
    } catch (cleanupError) {
      failure ??= cleanupError;
    }
  }
  if (failure) {
    progress.phase = failurePhase ?? "cleanup";
    throw failure;
  }
  progress.phase = "receipt";
  if (!successReceipt || !cleanupEvidence)
    throw new Error("qualification did not produce evidence");
  successReceipt.cleanup = {
    containerRemoved: cleanupEvidence.containerRemoved && cleanupEvidence.networkRemoved,
    credentialsRemoved: cleanupEvidence.keyFileRemoved && cleanupEvidence.tempFilesRemoved,
    listenerClosed:
      cleanupEvidence.loopbackListenerClosed && cleanupEvidence.registryListenerClosed,
    registryRemoved: cleanupEvidence.registryRemoved,
  };
  writeReceipt(invocation.output, successReceipt, names.tempRoot);
}

async function main(): Promise<void> {
  const invocation = parseQualificationInvocation(process.argv.slice(2));
  if (invocation.cleanupOnly) {
    const names = runtimeNames(invocation, process.env);
    try {
      await cleanupOwnedRuntime(names, undefined, {
        source: process.env.QUALIFICATION_PLAN ?? "",
        digest: process.env.PLAN_SHA256 ?? "",
      });
    } catch (error) {
      throw new QualificationFailureError(
        createLlamaCppDgxSparkFailureDiagnostic(
          {
            baseSha: process.env.BASE_SHA,
            headSha: process.env.CHECKOUT_SHA,
            workflowSha: process.env.WORKFLOW_SHA,
            runId: Number(invocation.runId),
            runAttempt: Number(invocation.runAttempt),
          },
          process.env.PLAN_SHA256,
          "cleanup",
          false,
          error instanceof QualificationCommandError ? "command-failed" : "cleanup-incomplete",
          error instanceof QualificationCommandError ? error.exitCode : null,
        ),
      );
    }
    process.stdout.write("DGX Spark qualification cleanup complete.\n");
    return;
  }
  await runQualification(invocation, process.env);
  process.stdout.write("DGX Spark qualification receipt created.\n");
}

export async function runQualificationCli(): Promise<void> {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      error instanceof QualificationFailureError
        ? `ERROR: ${error.message}\n`
        : "ERROR: DGX Spark qualification failed during trusted invocation or cleanup.\n",
    );
    process.exitCode = 1;
  }
}

export async function runQualificationLauncher(): Promise<void> {
  if (process.argv[2] === "--qualification-worker") {
    process.argv.splice(2, 1);
    await runQualificationCli();
    return;
  }
  let invocation: QualificationInvocation | CleanupInvocation;
  try {
    invocation = parseQualificationInvocation(process.argv.slice(2));
  } catch {
    process.stderr.write("ERROR: DGX Spark qualification rejected its trusted invocation.\n");
    process.exitCode = 1;
    return;
  }
  if (invocation.cleanupOnly) {
    await runQualificationCli();
    return;
  }
  // Keep signal delivery responsive while the worker builds or hashes synchronous inputs.
  const worker = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      process.argv[1]!,
      "--qualification-worker",
      ...process.argv.slice(2),
    ],
    { detached: process.platform === "linux", stdio: "inherit" },
  );
  let interrupted: NodeJS.Signals | undefined;
  let workerStopFailed = false;
  const interrupt = (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = signal;
    if (worker.pid === undefined) return;
    try {
      // Stop descendants too, before cleanup, so no build command can recreate owned state.
      if (process.platform === "linux") process.kill(-worker.pid, "SIGKILL");
      else worker.kill("SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        workerStopFailed = true;
        process.stderr.write("ERROR: Spark worker group termination was not proven.\n");
      }
    }
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("close", resolve);
    });
    if (!interrupted) {
      process.exitCode = status ?? 1;
      return;
    }
    const names = runtimeNames(invocation, process.env);
    let cleanupComplete = false;
    try {
      if (workerStopFailed) throw new Error("worker termination is unproven");
      const source = fs.existsSync(path.join(names.tempRoot, "managed-openshell"))
        ? readBoundedRegularFile(invocation.planFile, maximumPlanBytes)
        : "";
      await cleanupOwnedRuntime(names, undefined, { source, digest: invocation.planSha256 });
      cleanupComplete = true;
    } catch {
      process.stderr.write(
        "ERROR: Interrupted Spark cleanup is incomplete; inspect owned resources.\n",
      );
    }
    const diagnostic = createLlamaCppDgxSparkFailureDiagnostic(
      {
        baseSha: invocation.candidateBase,
        headSha: invocation.candidateHead,
        workflowSha: invocation.workflowSha,
        runId: Number(invocation.runId),
        runAttempt: Number(invocation.runAttempt),
      },
      invocation.planSha256,
      "interrupted",
      cleanupComplete,
    );
    process.exitCode = interrupted === "SIGINT" ? 130 : 143;
    try {
      writeReceipt(
        path.join(path.dirname(invocation.output), "failure.json"),
        diagnostic,
        names.tempRoot,
      );
    } catch {
      process.stderr.write("ERROR: Spark interruption diagnostic could not be retained.\n");
    }
  } catch {
    process.stderr.write("ERROR: Spark launcher failed; inspect this run's owned resources.\n");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void runQualificationCli();
