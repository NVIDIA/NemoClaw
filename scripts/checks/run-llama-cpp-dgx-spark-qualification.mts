// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildLlamaCppHostLocalDockerArgv,
  type VerifiedLocalModelArtifact,
} from "../../src/lib/inference/llama-cpp/host-local-runtime.ts";
import {
  LLAMA_CPP_DGX_SPARK_MODEL_PATH_PATTERN,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_IMAGE_REPOSITORY,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_KIND,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE,
  type LlamaCppDgxSparkExecutionPlan,
  parseLlamaCppDgxSparkExecutionPlan,
} from "./llama-cpp-dgx-spark-qualification-contract.mts";

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

function requiredInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
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
  if (
    environment.GITHUB_REPOSITORY !== "NVIDIA/NemoClaw" ||
    environment.GITHUB_REF !== "refs/heads/main" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_ACTOR !== "github-actions[bot]" ||
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
  if (cleanupOnly) return { cleanupOnly: true, registryName, registryOwner, runAttempt, runId };

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
  return buildLlamaCppHostLocalDockerArgv(plan.recipe, {
    apiKeyHostPath: options.apiKeyHostPath,
    containerName: options.containerName,
    imageReference: options.imageReference,
    model: options.model,
    network: { isolation: "docker-internal", name: options.networkName },
    ownerLabel: { name: registryOwnerLabel, value: options.registryOwner },
    runtimeGid: options.runtimeGid,
    runtimeUid: options.runtimeUid,
  });
}

export function validateStartupLog(log: string): { offloadedLayers: number; totalLayers: number } {
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

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
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
  const match = /^(NVIDIA GB10)\s*,\s*([0-9]{3}\.[0-9]{2}\.[0-9]{2})$/u.exec(lines[0] ?? "");
  if (!match) throw new Error("qualification host is not the expected NVIDIA GB10 profile");
  const driverVersion = match[2] as string;
  if (compareVersions(driverVersion, minimumDriverVersion) < 0) {
    throw new Error("NVIDIA driver is below the qualification minimum");
  }
  return { count: 1, driverVersion, name: "NVIDIA GB10" };
}

export function validateModelsResponse(value: unknown, expectedModel: string): void {
  if (
    !isRecord(value) ||
    value.object !== "list" ||
    !Array.isArray(value.data) ||
    value.data.length !== 1 ||
    !isRecord(value.data[0]) ||
    value.data[0].id !== expectedModel
  ) {
    throw new Error("models probe did not return the exact served model identity");
  }
}

export function validateChatCompletionResponse(value: unknown, expectedModel: string): void {
  if (
    !isRecord(value) ||
    value.object !== "chat.completion" ||
    value.model !== expectedModel ||
    !Array.isArray(value.choices) ||
    value.choices.length < 1 ||
    !isRecord(value.choices[0]) ||
    !isRecord(value.choices[0].message) ||
    typeof value.choices[0].message.content !== "string" ||
    value.choices[0].message.content.length < 1 ||
    value.choices[0].message.content.length > 4096
  ) {
    throw new Error("authenticated chat completion probe failed its response contract");
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { capture?: boolean; maximumBytes?: number } = {},
): Buffer {
  const capture = options.capture ?? true;
  const result = spawnSync(command, args, {
    encoding: null,
    maxBuffer: options.maximumBytes ?? 16 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "ignore"],
  });
  if (result.error || result.status !== 0) {
    const operation = args.slice(0, 2).join(" ");
    throw new Error(`${command} ${operation} failed`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
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

function dockerContainerOwner(name: string): string | null {
  const result = spawnSync(
    "docker",
    ["container", "inspect", "--format", `{{index .Config.Labels "${registryOwnerLabel}"}}`, name],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function dockerNetworkOwner(name: string): string | null {
  const result = spawnSync(
    "docker",
    ["network", "inspect", "--format", `{{index .Labels "${registryOwnerLabel}"}}`, name],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return result.status === 0 ? result.stdout.trim() : null;
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
): Promise<CleanupEvidence> {
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
  runCommand("docker", ["pull", "--platform", "linux/arm64", reference], { capture: false });
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
    labels["io.nvidia.nemoclaw.inference-server.cuda.architectures"] !== "121a-real"
  ) {
    throw new Error("candidate image identity does not match the qualification plan");
  }
  return { digest, imageId, reference };
}

function resolveLoopbackPort(containerName: string, containerPort: number): number {
  const value = runCommand("docker", ["port", containerName, `${containerPort}/tcp`])
    .toString("utf8")
    .trim();
  const match = /^127\.0\.0\.1:([1-9][0-9]{3,4})$/u.exec(value);
  if (!match) throw new Error("model server did not receive one loopback-only ephemeral port");
  return requiredInteger(Number.parseInt(match[1] ?? "0", 10), "loopback port", 1024, 65_535);
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMilliseconds: number,
  maximumBytes: number,
): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMilliseconds) });
  if (!response.ok) throw new Error("qualification HTTP probe returned a non-success status");
  const body = await response.text();
  if (Buffer.byteLength(body) < 1 || Buffer.byteLength(body) > maximumBytes) {
    throw new Error("qualification HTTP probe response exceeded its bound");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("qualification HTTP probe did not return JSON");
  }
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
  fs.writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, output);
}

async function runQualification(
  invocation: QualificationInvocation,
  environment: TrustedEnvironment,
): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "arm64") {
    throw new Error("DGX Spark qualification requires a Linux ARM64 host");
  }
  for (const command of ["docker", "git"]) {
    if (!commandSucceeds(command, ["--version"]))
      throw new Error(`qualification requires ${command}`);
  }
  validateCandidateCheckout(invocation);
  const planSource = readBoundedRegularFile(invocation.planFile, maximumPlanBytes);
  const plan = validateQualificationPlan(planSource, invocation.planSha256);
  const names = runtimeNames(invocation, environment);
  if (fs.existsSync(names.tempRoot)) fs.rmSync(names.tempRoot, { force: true, recursive: true });
  fs.mkdirSync(names.tempRoot, { mode: 0o700 });
  const metadataFile = path.join(names.tempRoot, "build-metadata.json");
  const apiKeyHostPath = path.join(names.tempRoot, "api-key");
  let loopbackPort: number | undefined;
  let successReceipt: JsonRecord | undefined;
  let failure: unknown;
  let cleanupEvidence: CleanupEvidence | undefined;
  try {
    if (await tcpOpen(5000)) throw new Error("refusing to reuse an existing localhost registry");
    startRegistry(names);
    await waitForRegistry();
    runCommand("docker", buildCandidateImageArgv(plan, invocation, metadataFile), {
      capture: false,
    });
    const image = inspectBuiltImage(plan, invocation, metadataFile);
    await removeOwnedRegistry(names);
    fs.rmSync(names.tempRoot, { force: true, recursive: true });
    fs.mkdirSync(names.tempRoot, { mode: 0o700 });
    const model = hashModelFile(invocation.modelHostPath, plan);
    const apiKey = randomBytes(32).toString("hex");
    fs.writeFileSync(apiKeyHostPath, apiKey, { encoding: "utf8", flag: "wx", mode: 0o600 });
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
    runCommand("docker", [
      "network",
      "create",
      "--internal",
      "--label",
      `${registryOwnerLabel}=${names.registryOwner}`,
      names.networkName,
    ]);
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
    loopbackPort = resolveLoopbackPort(names.containerName, plan.recipe.serve.port);
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
    await waitForHealth(loopbackPort, plan.recipe.readiness.timeoutSeconds);
    const authorization = `Bearer ${apiKey}`;
    const models = await requestJson(
      `http://127.0.0.1:${loopbackPort}/v1/models`,
      { headers: { Authorization: authorization } },
      10_000,
      1024 * 1024,
    );
    validateModelsResponse(models, plan.recipe.readiness.expectedModel);
    const completion = await requestJson(
      `http://127.0.0.1:${loopbackPort}/v1/chat/completions`,
      {
        body: JSON.stringify({
          max_tokens: 16,
          messages: [{ content: "Return one short readiness token.", role: "user" }],
          model: plan.recipe.model.servedName,
          temperature: 0,
        }),
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        method: "POST",
      },
      plan.recipe.serve.limits.requestTimeoutSeconds * 1000,
      plan.recipe.serve.limits.maxRequestBodyBytes,
    );
    validateChatCompletionResponse(completion, plan.recipe.model.servedName);
    const offload = validateStartupLog(
      runCommand("docker", ["logs", "--tail", "20000", names.containerName], {
        maximumBytes: 16 * 1024 * 1024,
      }).toString("utf8"),
    );
    successReceipt = {
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
      probes: {
        completion: {
          httpStatus: 200,
          model: plan.recipe.model.servedName,
          ok: true,
        },
        health: { httpStatus: 200, ok: true },
      },
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      cleanupEvidence = await cleanupOwnedRuntime(names, loopbackPort);
    } catch (cleanupError) {
      failure ??= cleanupError;
    }
  }
  if (failure) throw failure;
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
    await cleanupOwnedRuntime(names);
    process.stdout.write("DGX Spark qualification cleanup complete.\n");
    return;
  }
  await runQualification(invocation, process.env);
  process.stdout.write("DGX Spark qualification receipt created.\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.stderr.write("ERROR: DGX Spark qualification failed.\n");
    process.exitCode = 1;
  }
}
