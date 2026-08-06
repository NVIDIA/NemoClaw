// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCuaBuildIdentityStamp } from "../../src/lib/cua/build-identity.ts";
import {
  CUA_SECURITY_OPERATIONS,
  CUA_TARGET_OPERATIONS,
  CUA_TASK_OPERATIONS,
  type CuaComponentIdentity,
  type CuaFailure,
  type CuaInferenceIdentity,
  type CuaTaskResult,
  getCuaRuntimeReadinessDigest,
} from "../../src/lib/cua/contract.ts";
import { CUA_QUALIFICATION_ISOLATED_TASK_INPUT_PATH } from "../../src/lib/cua/qualification-artifact-runner.ts";
import {
  assertCuaQualificationBinding as assertRuntimeCuaQualificationBinding,
  CUA_QUALIFICATION_DENIALS,
  parseCuaQualificationEnvironment as parseRuntimeCuaQualificationEnvironment,
  parseCuaQualificationReceipt as parseRuntimeCuaQualificationReceipt,
} from "../../src/lib/cua/qualification-evidence.ts";
import type { CuaRuntimeManifest } from "../../src/lib/cua/runtime-manifest.ts";
import {
  parseCuaLifecycleRecord,
  parseCuaRuntimeReadiness,
  parseCuaSecurityAttestation,
  parseCuaTargetAttachment,
  parseCuaTargetManifest,
  parseCuaTaskResult,
} from "../../src/lib/cua/schema.ts";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RAW_SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,127}$/;
const MODEL_SELECTOR =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,7}$/;
const SENSITIVE_VALUE =
  /(?:auth|bearer|credential|password|secret|token)|(?:^|[/._-])(?:ghp_|sk-)/i;
const HOST_COORDINATE =
  /(?:[a-z][a-z0-9+.-]*:\/\/|@|[?#\\]|\b(?:\d{1,3}\.){3}\d{1,3}\b|\[[0-9a-f:]+\]|\b(?:localhost|ip6-localhost)(?:\.[a-z0-9-]+)*\b|\b[a-z0-9-]+\.(?:com|net|org|io|ai|dev|cloud|internal|local|invalid)\b)/i;
const IMMUTABLE_IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:+-]*@sha256:[0-9a-f]{64}$/;

export const CUA_QUALIFICATION_FILE_MAX_BYTES = 64 * 1024;
export const CUA_QUALIFICATION_EVIDENCE_DIGEST_MAX = 16;
export const CUA_QUALIFICATION_ARTIFACT_OUTPUT_MAX_BYTES = 16 * 1024;
export const CUA_QUALIFICATION_EXECUTABLE_MAX_BYTES = 256 * 1024 * 1024;
export const CUA_QUALIFICATION_SCENARIOS = ["browser"] as const;

export interface CuaQualificationTargetChannelIdentity {
  schemaVersion: "1.0.0";
  kind: "cua-qualification-target-channel-identity";
  protocol: "cua.qualification.target-channel/v1";
  serviceBundleDigest: string;
  targetImageDigest: string;
}

export interface CuaQualificationEnvironment {
  schemaVersion: "1.0.0";
  kind: "cua-qualification-environment";
  launchable: {
    version: string;
    digest: string;
  };
  nemoclawCommit: string;
  bundleReceiptSha256: string;
  hostTools: {
    node: string;
    docker: string;
    nvidiaSmi: string;
    nvidiaCtk: string;
  };
  targetChannel: CuaQualificationTargetChannelIdentity;
  gpu: {
    count: number;
    model: string;
    driverVersion: string;
    cudaVersion: string;
    containerToolkitVersion: string;
    probeImageDigest: string;
  };
}

export interface CuaQualificationReceipt {
  schemaVersion: "1.0.0";
  kind: "cua-qualification-receipt";
  status: "passed";
  launchable: {
    version: string;
    digest: string;
  };
  gpu: CuaQualificationEnvironment["gpu"];
  hostTools: CuaQualificationEnvironment["hostTools"];
  targetChannel: CuaQualificationTargetChannelIdentity;
  nemoclawCommit: string;
  bundleReceiptSha256: string;
  inference: CuaInferenceIdentity;
  components: {
    openshell: string;
    runtime: string;
    sandboxImage: string;
    targetAdapter: string;
    targetImage: string;
    serviceBundle: string;
    policy: string;
    taskProtocol: string;
    securityVerifier: string;
    fixture: string;
    oracle: string;
  };
  scenarios: Array<{
    id: (typeof CUA_QUALIFICATION_SCENARIOS)[number];
    taskId: string;
    status: "passed";
    fixtureStateDigest: string;
    stateDigest: string;
    evidenceDigests: string[];
  }>;
  denials: Array<{
    id: (typeof CUA_QUALIFICATION_DENIALS)[number];
    outcomeDigest: string;
  }>;
  cleanup: {
    targetDestroyObservationDigest: string;
    nemoclawDestroyObservationDigest: string;
    nemoclawStatusAbsenceObservationDigest: string;
    nemoclawRegistryAbsenceObservationDigest: string;
    openshellInventoryAbsenceObservationDigest: string;
  };
}

export interface CuaReleaseBundleReceipt {
  schema: "cua.release.bundle/v1";
  releaseId: string;
  platform: "linux/amd64";
  artifacts: {
    cli: { version: string; filename: string; size: number; sha256: string };
    services: { version: string; filename: string; size: number; sha256: string };
    image: {
      version: string;
      filename: string;
      size: number;
      sha256: string;
      manifestDigest: string;
    };
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function safeValue(value: unknown, label: string, pattern = SAFE_TEXT): string {
  const parsed = boundedString(value, label);
  if (!pattern.test(parsed) || SENSITIVE_VALUE.test(parsed) || HOST_COORDINATE.test(parsed)) {
    throw new Error(`${label} must be printable and coordinate- and credential-free`);
  }
  return parsed;
}

function digest(value: unknown, label: string): string {
  const parsed = boundedString(value, label);
  if (!SHA256.test(parsed)) throw new Error(`${label} must be a sha256 digest`);
  return parsed;
}

function rawDigest(value: unknown, label: string): string {
  const parsed = boundedString(value, label);
  if (!RAW_SHA256.test(parsed)) throw new Error(`${label} must be a lowercase SHA-256`);
  return parsed;
}

function artifactSize(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 8 * 1024 ** 3) {
    throw new Error(`${label} must be a positive size no larger than 8 GiB`);
  }
  return value as number;
}

function parseBundleArtifact(value: unknown, label: string) {
  const artifact = object(value, label);
  exactKeys(artifact, ["version", "filename", "size", "sha256"], label);
  return {
    version: safeValue(artifact.version, `${label}.version`, SAFE_ID),
    filename: safeValue(artifact.filename, `${label}.filename`, SAFE_ID),
    size: artifactSize(artifact.size, `${label}.size`),
    sha256: rawDigest(artifact.sha256, `${label}.sha256`),
  };
}

export function parseCuaReleaseBundleReceipt(value: unknown): CuaReleaseBundleReceipt {
  const bundle = object(value, "bundle receipt");
  exactKeys(bundle, ["schema", "releaseId", "platform", "artifacts"], "bundle receipt");
  if (bundle.schema !== "cua.release.bundle/v1") throw new Error("unsupported bundle schema");
  if (bundle.platform !== "linux/amd64") throw new Error("bundle platform must be linux/amd64");
  const artifacts = object(bundle.artifacts, "bundle artifacts");
  exactKeys(artifacts, ["cli", "services", "image"], "bundle artifacts");
  const image = object(artifacts.image, "bundle artifacts.image");
  exactKeys(
    image,
    ["version", "filename", "size", "sha256", "manifestDigest"],
    "bundle artifacts.image",
  );
  const parsedImage = parseBundleArtifact(
    {
      version: image.version,
      filename: image.filename,
      size: image.size,
      sha256: image.sha256,
    },
    "bundle artifacts.image",
  );
  return {
    schema: "cua.release.bundle/v1",
    releaseId: safeValue(bundle.releaseId, "bundle releaseId", SAFE_ID),
    platform: "linux/amd64",
    artifacts: {
      cli: parseBundleArtifact(artifacts.cli, "bundle artifacts.cli"),
      services: parseBundleArtifact(artifacts.services, "bundle artifacts.services"),
      image: {
        ...parsedImage,
        manifestDigest: digest(image.manifestDigest, "bundle artifacts.image.manifestDigest"),
      },
    },
  };
}

function positiveGpuCount(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 64) {
    throw new Error(`${label} must be an integer from 1 through 64`);
  }
  return value as number;
}

function parseGpu(value: unknown, label: string): CuaQualificationEnvironment["gpu"] {
  const gpu = object(value, label);
  exactKeys(
    gpu,
    [
      "count",
      "model",
      "driverVersion",
      "cudaVersion",
      "containerToolkitVersion",
      "probeImageDigest",
    ],
    label,
  );
  return {
    count: positiveGpuCount(gpu.count, `${label}.count`),
    model: safeValue(gpu.model, `${label}.model`),
    driverVersion: safeValue(gpu.driverVersion, `${label}.driverVersion`),
    cudaVersion: safeValue(gpu.cudaVersion, `${label}.cudaVersion`),
    containerToolkitVersion: safeValue(
      gpu.containerToolkitVersion,
      `${label}.containerToolkitVersion`,
    ),
    probeImageDigest: digest(gpu.probeImageDigest, `${label}.probeImageDigest`),
  };
}

function parseHostTools(value: unknown, label: string): CuaQualificationEnvironment["hostTools"] {
  const tools = object(value, label);
  const keys = ["node", "docker", "nvidiaSmi", "nvidiaCtk"] as const;
  exactKeys(tools, keys, label);
  return {
    node: digest(tools.node, `${label}.node`),
    docker: digest(tools.docker, `${label}.docker`),
    nvidiaSmi: digest(tools.nvidiaSmi, `${label}.nvidiaSmi`),
    nvidiaCtk: digest(tools.nvidiaCtk, `${label}.nvidiaCtk`),
  };
}

function parseTargetChannel(value: unknown): CuaQualificationTargetChannelIdentity {
  const targetChannel = object(value, "targetChannel");
  exactKeys(
    targetChannel,
    ["schemaVersion", "kind", "protocol", "serviceBundleDigest", "targetImageDigest"],
    "targetChannel",
  );
  if (targetChannel.schemaVersion !== "1.0.0") {
    throw new Error("unsupported targetChannel schema");
  }
  if (targetChannel.kind !== "cua-qualification-target-channel-identity") {
    throw new Error("unexpected targetChannel kind");
  }
  if (targetChannel.protocol !== "cua.qualification.target-channel/v1") {
    throw new Error("unsupported targetChannel protocol");
  }
  return {
    schemaVersion: "1.0.0",
    kind: "cua-qualification-target-channel-identity",
    protocol: "cua.qualification.target-channel/v1",
    serviceBundleDigest: digest(
      targetChannel.serviceBundleDigest,
      "targetChannel.serviceBundleDigest",
    ),
    targetImageDigest: digest(targetChannel.targetImageDigest, "targetChannel.targetImageDigest"),
  };
}

function parseInference(value: unknown, label: string): CuaInferenceIdentity {
  const inference = object(value, label);
  exactKeys(inference, ["provider", "model", "routeDigest"], label);
  return {
    provider: safeValue(inference.provider, `${label}.provider`, SAFE_ID),
    model: safeValue(inference.model, `${label}.model`, MODEL_SELECTOR),
    routeDigest: digest(inference.routeDigest, `${label}.routeDigest`),
  };
}

interface BoundedQualificationFile {
  bytes: Buffer;
  sha256: string;
  mode: bigint;
}

function readBoundedCuaQualificationFile(
  filePath: string,
  maxBytes = CUA_QUALIFICATION_FILE_MAX_BYTES,
  consume = false,
): BoundedQualificationFile {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("qualification file size limit must be a positive safe integer");
  }
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.size > BigInt(maxBytes)) {
    throw new Error(`${filePath} must be a regular file no larger than ${String(maxBytes)} bytes`);
  }
  if (
    consume &&
    (before.nlink !== 1n ||
      ((before.mode & 0o7777n) !== 0o400n && (before.mode & 0o7777n) !== 0o600n))
  ) {
    throw new Error("the qualification receipt must be one owner-only file with no hard links");
  }

  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.mode !== before.mode ||
      opened.nlink !== before.nlink ||
      opened.uid !== before.uid ||
      opened.gid !== before.gid ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs ||
      opened.size > BigInt(maxBytes)
    ) {
      throw new Error(`${filePath} changed during bounded validation`);
    }
    const expectedSize = Number(opened.size);
    const bytes = Buffer.alloc(Math.min(expectedSize + 1, maxBytes + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      offset !== expectedSize ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.mode !== opened.mode ||
      after.nlink !== opened.nlink ||
      after.uid !== opened.uid ||
      after.gid !== opened.gid ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      throw new Error(`${filePath} changed during bounded validation`);
    }
    const raw = bytes.subarray(0, offset);
    if (consume) {
      const pathname = fs.lstatSync(filePath, { bigint: true });
      if (
        !pathname.isFile() ||
        pathname.dev !== opened.dev ||
        pathname.ino !== opened.ino ||
        pathname.mode !== opened.mode ||
        pathname.nlink !== 1n ||
        pathname.uid !== opened.uid ||
        pathname.gid !== opened.gid ||
        pathname.size !== opened.size ||
        pathname.mtimeNs !== opened.mtimeNs ||
        pathname.ctimeNs !== opened.ctimeNs
      ) {
        throw new Error(`${filePath} changed before one-shot consumption`);
      }
      fs.unlinkSync(filePath);
      const unlinked = fs.fstatSync(fd, { bigint: true });
      if (
        !unlinked.isFile() ||
        unlinked.dev !== opened.dev ||
        unlinked.ino !== opened.ino ||
        unlinked.nlink !== 0n ||
        unlinked.size !== opened.size
      ) {
        throw new Error(`${filePath} was not consumed as one exact file`);
      }
    }
    return {
      bytes: raw,
      sha256: `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`,
      mode: opened.mode,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function hashBoundedCuaQualificationFile(
  filePath: string,
  maxBytes = CUA_QUALIFICATION_FILE_MAX_BYTES,
): { sha256: string; sizeBytes: number } {
  const file = readBoundedCuaQualificationFile(filePath, maxBytes);
  return { sha256: file.sha256, sizeBytes: file.bytes.length };
}

export function readBoundedCuaQualificationJson(
  filePath: string,
  maxBytes = CUA_QUALIFICATION_FILE_MAX_BYTES,
): { value: unknown; sha256: string } {
  const file = readBoundedCuaQualificationFile(filePath, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(file.bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${filePath} must contain strict JSON`);
  }
  return { value, sha256: file.sha256 };
}

/**
 * Read the expected qualification receipt once and remove its only pathname.
 *
 * Fixture, oracle, and adapter processes run under the qualification user's
 * UID. Expected observations therefore cannot remain in a same-UID-readable
 * file while those processes execute. The receipt handoff must be an
 * owner-only regular file in an owner-only directory and must have no hard
 * links. After the stable bounded read, this function unlinks that exact inode
 * while its no-follow descriptor is still open. Callers retain only the parsed
 * controller-side value and content digest.
 */
export function consumeBoundedCuaQualificationJson(
  filePath: string,
  maxBytes = CUA_QUALIFICATION_FILE_MAX_BYTES,
): { value: unknown; sha256: string; consumedPath: string } {
  if (!path.isAbsolute(filePath) || filePath.includes("\0")) {
    throw new Error("the qualification receipt must name one absolute file");
  }
  const supplied = fs.lstatSync(filePath, { bigint: true });
  if (!supplied.isFile() || supplied.isSymbolicLink()) {
    throw new Error("the qualification receipt must be a regular non-symlink file");
  }
  const consumedPath = fs.realpathSync(filePath);
  const parent = path.dirname(consumedPath);
  const parentStat = fs.lstatSync(parent, { bigint: true });
  const effectiveUid = process.geteuid?.() ?? process.getuid?.();
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (parentStat.mode & 0o7777n) !== 0o700n ||
    effectiveUid === undefined ||
    parentStat.uid !== BigInt(effectiveUid) ||
    supplied.uid !== BigInt(effectiveUid)
  ) {
    throw new Error(
      "the qualification receipt must be owned by the qualification user in an owner-only directory",
    );
  }

  const file = readBoundedCuaQualificationFile(consumedPath, maxBytes, true);
  let value: unknown;
  try {
    value = JSON.parse(file.bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${consumedPath} must contain strict JSON`);
  }
  return { value, sha256: file.sha256, consumedPath };
}

export interface CuaQualificationCliInvocation {
  command: string;
  commandDigest: string;
  commandSizeBytes: number;
  argsPrefix: readonly [string];
  cwd: string;
  launcherDigest: string;
  path: string;
}

export interface CuaQualificationExecutableIdentity {
  path: string;
  digest: string;
  sizeBytes: number;
}

export interface CuaQualificationHostToolBindings {
  node: CuaQualificationExecutableIdentity;
  docker: CuaQualificationExecutableIdentity;
  nvidiaSmi: CuaQualificationExecutableIdentity;
  nvidiaCtk: CuaQualificationExecutableIdentity;
}

/** Resolve one root-owned executable whose path cannot be replaced by the qualification user. */
export function resolveCuaQualificationExecutable(
  executablePath: string,
  label: string,
  maxBytes = CUA_QUALIFICATION_EXECUTABLE_MAX_BYTES,
): CuaQualificationExecutableIdentity {
  if (!path.isAbsolute(executablePath) || executablePath.includes("\0")) {
    throw new Error(`${label} must be one absolute executable path`);
  }
  const resolved = fs.realpathSync(executablePath);
  if (resolved !== executablePath) {
    throw new Error(`${label} must use its canonical executable path`);
  }
  const stat = fs.lstatSync(resolved, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0n ||
    stat.nlink !== 1n ||
    (stat.mode & 0o111n) === 0n ||
    (stat.mode & 0o7022n) !== 0n
  ) {
    throw new Error(`${label} must resolve to one root-owned non-writable executable`);
  }
  let ancestor = path.dirname(resolved);
  for (;;) {
    const ancestorStat = fs.lstatSync(ancestor, { bigint: true });
    if (
      !ancestorStat.isDirectory() ||
      ancestorStat.isSymbolicLink() ||
      ancestorStat.uid !== 0n ||
      (ancestorStat.mode & 0o022n) !== 0n
    ) {
      throw new Error(`${label} must have a root-owned non-writable authority path`);
    }
    if (ancestor === path.parse(ancestor).root) break;
    ancestor = path.dirname(ancestor);
  }
  const file = hashBoundedCuaQualificationFile(resolved, maxBytes);
  return Object.freeze({ path: resolved, digest: file.sha256, sizeBytes: file.sizeBytes });
}

/** Bind every executable used for host qualification to the immutable environment evidence. */
export function resolveCuaQualificationHostToolBindings(
  expected: CuaQualificationEnvironment["hostTools"],
  paths: { node: string; docker: string; nvidiaSmi: string; nvidiaCtk: string },
): CuaQualificationHostToolBindings {
  const bindings = {
    node: resolveCuaQualificationExecutable(paths.node, "qualification Node.js"),
    docker: resolveCuaQualificationExecutable(paths.docker, "qualification Docker CLI"),
    nvidiaSmi: resolveCuaQualificationExecutable(paths.nvidiaSmi, "qualification nvidia-smi"),
    nvidiaCtk: resolveCuaQualificationExecutable(paths.nvidiaCtk, "qualification nvidia-ctk"),
  };
  for (const key of ["node", "docker", "nvidiaSmi", "nvidiaCtk"] as const) {
    if (bindings[key].digest !== expected[key]) {
      throw new Error(`qualification hostTools.${key} does not match the executing tool`);
    }
  }
  return Object.freeze(bindings);
}

/** Re-resolve and rehash every trusted host tool after the live sequence. */
export function assertCuaQualificationHostToolBindingsUnchanged(
  bindings: CuaQualificationHostToolBindings,
): void {
  for (const key of ["node", "docker", "nvidiaSmi", "nvidiaCtk"] as const) {
    const current = resolveCuaQualificationExecutable(bindings[key].path, `qualification ${key}`);
    if (
      current.path !== bindings[key].path ||
      current.digest !== bindings[key].digest ||
      current.sizeBytes !== bindings[key].sizeBytes
    ) {
      throw new Error(`qualification ${key} changed during live execution`);
    }
  }
}

/** Pin qualification to the launcher in the exact checkout, never a PATH shim. */
export function resolveCuaQualificationCliInvocation(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
  nodeExecutable = process.execPath,
): CuaQualificationCliInvocation {
  const cwd = fs.realpathSync(root);
  const launcher = path.join(cwd, "bin", "nemoclaw.js");
  if (fs.realpathSync(launcher) !== launcher) {
    throw new Error("qualification NemoClaw launcher must be a canonical checkout file");
  }
  const configured = environment.NEMOCLAW_CLI_BIN;
  if (configured !== undefined) {
    if (
      configured.length === 0 ||
      configured !== configured.trim() ||
      !path.isAbsolute(configured) ||
      fs.realpathSync(configured) !== launcher
    ) {
      throw new Error("NEMOCLAW_CLI_BIN must name the exact qualification checkout launcher");
    }
  }
  const launcherFile = readBoundedCuaQualificationFile(launcher, 256 * 1024);
  if ((launcherFile.mode & 0o111n) === 0n || (launcherFile.mode & 0o7022n) !== 0n) {
    throw new Error("qualification NemoClaw launcher mode is unsafe");
  }
  const node = resolveCuaQualificationExecutable(nodeExecutable, "qualification Node.js");
  const command = node.path;
  const safePath = [path.dirname(command), "/usr/sbin", "/usr/bin", "/sbin", "/bin"]
    .filter((entry, index, values) => values.indexOf(entry) === index)
    .join(":");
  return Object.freeze({
    command,
    commandDigest: node.digest,
    commandSizeBytes: node.sizeBytes,
    argsPrefix: Object.freeze([launcher]) as readonly [string],
    cwd,
    launcherDigest: launcherFile.sha256,
    path: safePath,
  });
}

/** Recheck the checkout launcher around the complete live command sequence. */
export function assertCuaQualificationCliInvocationUnchanged(
  invocation: CuaQualificationCliInvocation,
): void {
  const launcher = invocation.argsPrefix[0];
  const current = readBoundedCuaQualificationFile(launcher, 256 * 1024);
  if (
    fs.realpathSync(launcher) !== launcher ||
    current.sha256 !== invocation.launcherDigest ||
    (current.mode & 0o111n) === 0n ||
    (current.mode & 0o7022n) !== 0n
  ) {
    throw new Error("qualification NemoClaw launcher changed during live execution");
  }
  const node = resolveCuaQualificationExecutable(invocation.command, "qualification Node.js");
  if (
    node.path !== invocation.command ||
    node.digest !== invocation.commandDigest ||
    node.sizeBytes !== invocation.commandSizeBytes
  ) {
    throw new Error("qualification Node.js executable changed during live execution");
  }
}

export interface CuaQualificationAuthorityFileInput {
  sourcePath: string;
  maxBytes: number;
  expectedDigest: string;
  executable?: boolean;
}

export interface CuaQualificationAuthoritySnapshot {
  directory: string;
  files: Readonly<Record<string, string>>;
  digests: Readonly<Record<string, string>>;
  seal: (additionalChildren?: readonly string[]) => void;
  cleanup: () => void;
}

const AUTHORITY_CHILD_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,255}$/;

function removeCuaQualificationAuthority(directory: string): void {
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isDirectory() && !stat.isSymbolicLink()) fs.chmodSync(directory, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

/**
 * Copy every qualification input from one stable no-follow descriptor into a
 * private, non-writable authority directory. Callers consume only these paths.
 */
export function stageCuaQualificationAuthorityFiles(
  inputs: Readonly<Record<string, CuaQualificationAuthorityFileInput>>,
): CuaQualificationAuthoritySnapshot {
  const entries = Object.entries(inputs);
  if (entries.length === 0 || entries.length > 64) {
    throw new Error("qualification authority requires 1 through 64 files");
  }
  let directory: string | undefined;
  try {
    directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-qualification-authority-")),
    );
    fs.chmodSync(directory, 0o700);
    const files: Record<string, string> = {};
    const digests: Record<string, string> = {};
    for (const [key, input] of entries) {
      if (!SAFE_ID.test(key)) throw new Error("qualification authority file keys must be safe IDs");
      const expectedDigest = digest(input.expectedDigest, `${key} expected digest`);
      const source = readBoundedCuaQualificationFile(input.sourcePath, input.maxBytes);
      if (source.sha256 !== expectedDigest) {
        throw new Error(`${key} does not match its expected qualification digest`);
      }
      if (input.executable === true && (source.mode & 0o111n) === 0n) {
        throw new Error(`${key} must be executable`);
      }
      const destination = path.join(directory, `.${key}`);
      const mode = input.executable === true ? 0o500 : 0o400;
      const descriptor = fs.openSync(
        destination,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        mode,
      );
      try {
        fs.fchmodSync(descriptor, mode);
        let offset = 0;
        while (offset < source.bytes.length) {
          offset += fs.writeSync(descriptor, source.bytes, offset, source.bytes.length - offset);
        }
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      files[key] = destination;
      digests[key] = source.sha256;
    }
    const snapshotDirectory = directory;
    const stagedChildren = entries.map(([key]) => `.${key}`);
    let sealed = false;
    return {
      directory: snapshotDirectory,
      files: Object.freeze(files),
      digests: Object.freeze(digests),
      seal: (additionalChildren = []) => {
        try {
          const expectedChildren = [...stagedChildren, ...additionalChildren];
          if (
            expectedChildren.length > 128 ||
            expectedChildren.some((child) => !AUTHORITY_CHILD_NAME.test(child)) ||
            new Set(expectedChildren).size !== expectedChildren.length
          ) {
            throw new Error("qualification authority expected child names must be exact");
          }
          const children = fs.readdirSync(snapshotDirectory);
          if (
            children.length !== expectedChildren.length ||
            [...children].sort().join("\0") !== [...expectedChildren].sort().join("\0")
          ) {
            throw new Error("qualification authority does not contain its exact expected file set");
          }
          for (const child of children) {
            const childPath = path.join(snapshotDirectory, child);
            const stat = fs.lstatSync(childPath);
            const mode = stat.mode & 0o777;
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              stat.nlink !== 1 ||
              (mode !== 0o400 && mode !== 0o500)
            ) {
              throw new Error(
                "qualification authority children must be non-writable regular files",
              );
            }
          }
          fs.chmodSync(snapshotDirectory, 0o500);
          sealed = true;
          if ((fs.lstatSync(snapshotDirectory).mode & 0o777) !== 0o500) {
            throw new Error("qualification authority directory could not be sealed");
          }
        } catch (error) {
          removeCuaQualificationAuthority(snapshotDirectory);
          sealed = false;
          throw error;
        }
      },
      cleanup: () => {
        if (sealed || fs.existsSync(snapshotDirectory)) {
          removeCuaQualificationAuthority(snapshotDirectory);
        }
      },
    };
  } catch (error) {
    if (directory) removeCuaQualificationAuthority(directory);
    throw error;
  }
}

/**
 * Register cleanup immediately after the base authority snapshot exists. This
 * boundary covers runtime-payload staging, mode changes, generated children,
 * and sealing; callers cannot leak a partially prepared authority directory.
 */
export function prepareCuaQualificationAuthority(
  inputs: Readonly<Record<string, CuaQualificationAuthorityFileInput>>,
  prepare: (authority: CuaQualificationAuthoritySnapshot) => void,
): CuaQualificationAuthoritySnapshot {
  const authority = stageCuaQualificationAuthorityFiles(inputs);
  try {
    prepare(authority);
    return authority;
  } catch (error) {
    authority.cleanup();
    throw error;
  }
}

export function parseCuaQualificationEnvironment(value: unknown): CuaQualificationEnvironment {
  // Candidate qualification must accept no evidence that the immutable final
  // runtime parser would later reject.
  parseRuntimeCuaQualificationEnvironment(value);
  const identity = object(value, "qualification environment");
  exactKeys(
    identity,
    [
      "schemaVersion",
      "kind",
      "launchable",
      "nemoclawCommit",
      "bundleReceiptSha256",
      "gpu",
      "hostTools",
      "targetChannel",
    ],
    "qualification environment",
  );
  if (identity.schemaVersion !== "1.0.0") throw new Error("unsupported environment schema");
  if (identity.kind !== "cua-qualification-environment") {
    throw new Error("unexpected qualification environment kind");
  }
  const launchable = object(identity.launchable, "launchable");
  exactKeys(launchable, ["version", "digest"], "launchable");
  const launchableVersion = boundedString(launchable.version, "launchable.version");
  if (!VERSION.test(launchableVersion)) throw new Error("launchable.version must be semver");
  const nemoclawCommit = boundedString(identity.nemoclawCommit, "nemoclawCommit");
  if (!COMMIT.test(nemoclawCommit)) {
    throw new Error("nemoclawCommit must be an exact lowercase 40-hex commit");
  }
  return {
    schemaVersion: "1.0.0",
    kind: "cua-qualification-environment",
    launchable: {
      version: launchableVersion,
      digest: digest(launchable.digest, "launchable.digest"),
    },
    nemoclawCommit,
    bundleReceiptSha256: rawDigest(identity.bundleReceiptSha256, "bundleReceiptSha256"),
    gpu: parseGpu(identity.gpu, "gpu"),
    hostTools: parseHostTools(identity.hostTools, "hostTools"),
    targetChannel: parseTargetChannel(identity.targetChannel),
  };
}

export function parseCuaQualificationReceipt(value: unknown): CuaQualificationReceipt {
  // Keep the live gate on the same content boundary used by final readiness.
  // The checks below deliberately add candidate-only cardinality constraints.
  const runtimeReceipt = parseRuntimeCuaQualificationReceipt(value);
  const receipt = object(value, "receipt");
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "kind",
      "status",
      "launchable",
      "gpu",
      "hostTools",
      "targetChannel",
      "nemoclawCommit",
      "bundleReceiptSha256",
      "inference",
      "components",
      "scenarios",
      "denials",
      "cleanup",
    ],
    "receipt",
  );
  if (receipt.schemaVersion !== "1.0.0") throw new Error("unsupported receipt schema");
  if (receipt.kind !== "cua-qualification-receipt") throw new Error("unexpected receipt kind");
  if (receipt.status !== "passed") throw new Error("qualification did not pass");
  if (typeof receipt.nemoclawCommit !== "string" || !COMMIT.test(receipt.nemoclawCommit)) {
    throw new Error("nemoclawCommit must be an exact lowercase 40-hex commit");
  }

  const launchable = object(receipt.launchable, "launchable");
  exactKeys(launchable, ["version", "digest"], "launchable");
  const launchableVersion = boundedString(launchable.version, "launchable.version");
  if (!VERSION.test(launchableVersion)) throw new Error("launchable.version must be semver");

  const components = object(receipt.components, "components");
  exactKeys(
    components,
    [
      "openshell",
      "runtime",
      "sandboxImage",
      "targetAdapter",
      "targetImage",
      "serviceBundle",
      "policy",
      "taskProtocol",
      "securityVerifier",
      "fixture",
      "oracle",
    ],
    "components",
  );
  const parsedComponents = Object.fromEntries(
    Object.entries(components).map(([key, identity]) => [
      key,
      digest(identity, `components.${key}`),
    ]),
  ) as CuaQualificationReceipt["components"];

  if (
    !Array.isArray(receipt.scenarios) ||
    receipt.scenarios.length !== CUA_QUALIFICATION_SCENARIOS.length
  ) {
    throw new Error("scenarios must contain exactly one browser record");
  }
  const seen = new Set<string>();
  const seenTaskIds = new Set<string>();
  const scenarioDigestOwners = new Map<string, string>();
  const scenarios: CuaQualificationReceipt["scenarios"] = [];
  for (const [index, rawScenario] of receipt.scenarios.entries()) {
    const scenario = object(rawScenario, `scenarios[${index}]`);
    exactKeys(
      scenario,
      ["id", "taskId", "status", "fixtureStateDigest", "stateDigest", "evidenceDigests"],
      `scenarios[${index}]`,
    );
    if (
      typeof scenario.id !== "string" ||
      !CUA_QUALIFICATION_SCENARIOS.includes(
        scenario.id as (typeof CUA_QUALIFICATION_SCENARIOS)[number],
      )
    ) {
      throw new Error(`scenarios[${index}].id is unsupported`);
    }
    if (seen.has(scenario.id)) throw new Error(`duplicate scenario ${scenario.id}`);
    seen.add(scenario.id);
    if (scenario.status !== "passed") throw new Error(`scenario ${scenario.id} did not pass`);
    if (
      !Array.isArray(scenario.evidenceDigests) ||
      scenario.evidenceDigests.length === 0 ||
      scenario.evidenceDigests.length > CUA_QUALIFICATION_EVIDENCE_DIGEST_MAX
    ) {
      throw new Error(
        `scenario ${scenario.id} requires 1 through ${String(CUA_QUALIFICATION_EVIDENCE_DIGEST_MAX)} private evidence references`,
      );
    }
    const taskId = safeValue(scenario.taskId, `scenarios[${index}].taskId`, SAFE_ID);
    if (seenTaskIds.has(taskId)) throw new Error(`duplicate scenario taskId ${taskId}`);
    seenTaskIds.add(taskId);
    const evidenceDigests = scenario.evidenceDigests.map((entry, evidenceIndex) =>
      digest(entry, `scenarios[${index}].evidenceDigests[${evidenceIndex}]`),
    );
    if (new Set(evidenceDigests).size !== evidenceDigests.length) {
      throw new Error(`scenario ${scenario.id} contains duplicate evidence digests`);
    }
    const fixtureStateDigest = digest(
      scenario.fixtureStateDigest,
      `scenarios[${index}].fixtureStateDigest`,
    );
    const stateDigest = digest(scenario.stateDigest, `scenarios[${index}].stateDigest`);
    if (fixtureStateDigest === stateDigest || evidenceDigests.includes(fixtureStateDigest)) {
      throw new Error(`scenario ${scenario.id} fixture state must be distinct from final evidence`);
    }
    if (!evidenceDigests.includes(stateDigest)) {
      throw new Error(`scenario ${scenario.id} state digest must be included in evidence digests`);
    }
    for (const claimedDigest of new Set([fixtureStateDigest, ...evidenceDigests])) {
      const priorOwner = scenarioDigestOwners.get(claimedDigest);
      if (priorOwner) {
        throw new Error(
          `scenario ${scenario.id} reuses qualification evidence from scenario ${priorOwner}`,
        );
      }
      scenarioDigestOwners.set(claimedDigest, scenario.id);
    }
    scenarios.push({
      id: scenario.id as (typeof CUA_QUALIFICATION_SCENARIOS)[number],
      taskId,
      status: "passed",
      fixtureStateDigest,
      stateDigest,
      evidenceDigests,
    });
  }

  if (
    !Array.isArray(receipt.denials) ||
    receipt.denials.length !== CUA_QUALIFICATION_DENIALS.length
  ) {
    throw new Error("denials must contain exactly four records");
  }
  const seenDenials = new Set<string>();
  const denials = receipt.denials.map((rawDenial, index) => {
    const denial = object(rawDenial, `denials[${index}]`);
    exactKeys(denial, ["id", "outcomeDigest"], `denials[${index}]`);
    if (
      typeof denial.id !== "string" ||
      !CUA_QUALIFICATION_DENIALS.includes(
        denial.id as (typeof CUA_QUALIFICATION_DENIALS)[number],
      ) ||
      seenDenials.has(denial.id)
    ) {
      throw new Error(`denials[${index}].id is unsupported or duplicated`);
    }
    seenDenials.add(denial.id);
    return {
      id: denial.id as (typeof CUA_QUALIFICATION_DENIALS)[number],
      outcomeDigest: digest(denial.outcomeDigest, `denials[${index}].outcomeDigest`),
    };
  });
  if (CUA_QUALIFICATION_DENIALS.some((id) => !seenDenials.has(id))) {
    throw new Error("denials must cover every required fail-closed exercise");
  }

  return {
    schemaVersion: "1.0.0",
    kind: "cua-qualification-receipt",
    status: "passed",
    launchable: {
      version: launchableVersion,
      digest: digest(launchable.digest, "launchable.digest"),
    },
    gpu: parseGpu(receipt.gpu, "gpu"),
    hostTools: parseHostTools(receipt.hostTools, "hostTools"),
    targetChannel: parseTargetChannel(receipt.targetChannel),
    nemoclawCommit: receipt.nemoclawCommit,
    bundleReceiptSha256: rawDigest(receipt.bundleReceiptSha256, "bundleReceiptSha256"),
    inference: parseInference(receipt.inference, "inference"),
    components: parsedComponents,
    scenarios,
    denials,
    cleanup: runtimeReceipt.cleanup,
  };
}

export type CuaQualificationTargetObservationPhase = "cleanup-target-destroy";

export type CuaQualificationSandboxObservation =
  | "nemoclaw-destroyed"
  | "nemoclaw-status-absent"
  | "nemoclaw-registry-absent"
  | "openshell-inventory-absent";

function canonicalQualificationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalQualificationValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalQualificationValue(child)]),
  );
}

function qualificationObservationDigest(value: unknown): string {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalQualificationValue(value)))
    .digest("hex")}`;
}

/** Domain-bind one exact public target observation to its live qualification phase. */
export function getCuaQualificationTargetObservationDigest(
  phase: CuaQualificationTargetObservationPhase,
  value: unknown,
): string {
  const target = parseCuaTargetAttachment(value);
  if (target.status !== "detached" || target.target !== null || target.activeTask !== null) {
    throw new Error(`${phase} did not produce the required public target observation`);
  }
  return qualificationObservationDigest({
    schemaVersion: "1.0.0",
    kind: "cua-qualification-target-observation",
    phase,
    target,
  });
}

/** Bind a content-free independently established sandbox outcome to one sandbox name. */
export function getCuaQualificationSandboxObservationDigest(
  observation: CuaQualificationSandboxObservation,
  sandboxName: string,
): string {
  return qualificationObservationDigest({
    schemaVersion: "1.0.0",
    kind: "cua-qualification-sandbox-observation",
    observation,
    sandboxName: safeValue(sandboxName, "qualification sandboxName", SAFE_ID),
  });
}

export interface CuaQualificationCleanupObservations {
  targetDestroy: unknown;
  sandboxName: string;
  nemoclawDestroy: "completed";
  nemoclawStatus: "absent";
  nemoclawRegistry: "absent";
  openshellInventory: "absent";
}

/** Require independently observed target, NemoClaw, registry, and OpenShell cleanup outcomes. */
export function assertCuaQualificationCleanupBindings(
  receipt: CuaQualificationReceipt,
  observations: CuaQualificationCleanupObservations,
): void {
  const expected = {
    targetDestroyObservationDigest: getCuaQualificationTargetObservationDigest(
      "cleanup-target-destroy",
      observations.targetDestroy,
    ),
    nemoclawDestroyObservationDigest: getCuaQualificationSandboxObservationDigest(
      "nemoclaw-destroyed",
      observations.sandboxName,
    ),
    nemoclawStatusAbsenceObservationDigest: getCuaQualificationSandboxObservationDigest(
      "nemoclaw-status-absent",
      observations.sandboxName,
    ),
    nemoclawRegistryAbsenceObservationDigest: getCuaQualificationSandboxObservationDigest(
      "nemoclaw-registry-absent",
      observations.sandboxName,
    ),
    openshellInventoryAbsenceObservationDigest: getCuaQualificationSandboxObservationDigest(
      "openshell-inventory-absent",
      observations.sandboxName,
    ),
  };
  if (
    observations.nemoclawDestroy !== "completed" ||
    observations.nemoclawStatus !== "absent" ||
    observations.nemoclawRegistry !== "absent" ||
    observations.openshellInventory !== "absent" ||
    Object.keys(expected).some(
      (key) =>
        expected[key as keyof typeof expected] !== receipt.cleanup[key as keyof typeof expected],
    )
  ) {
    throw new Error("final cleanup observations do not match the qualification receipt");
  }
}

function componentDigest(component: CuaComponentIdentity, expected: string, label: string) {
  if (component.digest !== expected) throw new Error(`${label} does not match the receipt`);
}

export interface CuaCandidateRuntimeBindings {
  sourceRevision: string;
  sourceClean: boolean;
  runtimeManifestDigest: string;
  environmentDigest: string;
  bundleReceiptDigest: string;
}

export interface CuaQualificationFileDigests {
  environment: string;
  receipt: string;
  bundleReceipt: string;
}

export interface CuaQualificationGpuObservations {
  host: CuaQualificationEnvironment["gpu"];
  probe: Omit<CuaQualificationEnvironment["gpu"], "containerToolkitVersion">;
}

/** Bind the three externally supplied qualification files to exact raw hashes. */
export function assertCuaQualificationFileDigests(
  actual: CuaQualificationFileDigests,
  expected: CuaQualificationFileDigests,
): void {
  for (const key of ["environment", "receipt", "bundleReceipt"] as const) {
    const actualDigest = digest(actual[key], `${key} file digest`);
    const expectedDigest = digest(expected[key], `expected ${key} file digest`);
    if (actualDigest !== expectedDigest) {
      throw new Error(`${key} file digest does not match the qualification input`);
    }
  }
}

/** Require one exact clean checkout without hidden index worktree exceptions. */
export function assertCuaQualificationGitCheckout(root: string, expectedCommit: string): void {
  const commit = boundedString(expectedCommit, "expected qualification commit");
  if (!COMMIT.test(commit)) throw new Error("expected qualification commit must be exact");
  const identity = createCuaBuildIdentityStamp(fs.realpathSync(root), commit);
  if (identity.sourceRevision !== commit || identity.sourceClean !== true) {
    throw new Error("qualification checkout is not the exact clean receipt-bound source");
  }
}

export type CuaQualificationGpuProbeObservation = "model" | "driver" | "summary";

/** Return the only Docker argv accepted for the immutable live GPU probe. */
export function buildCuaQualificationGpuProbeArgs(
  reference: string,
  expectedDigest: string,
  observation: CuaQualificationGpuProbeObservation,
): string[] {
  const approvedDigest = digest(expectedDigest, "approved GPU probe image digest");
  if (
    reference.length > 4096 ||
    !IMMUTABLE_IMAGE_REFERENCE.test(reference) ||
    !reference.endsWith(`@${approvedDigest}`)
  ) {
    throw new Error("GPU probe image must match the approved immutable digest");
  }
  const observationArgs = {
    model: ["--query-gpu=name", "--format=csv,noheader"],
    driver: ["--query-gpu=driver_version", "--format=csv,noheader"],
    summary: [],
  }[observation];
  return [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=65534:65534",
    "--pids-limit=64",
    "--memory=512m",
    "--cpus=1",
    "--ulimit=nofile=64:64",
    "--gpus=all",
    "--entrypoint=/usr/bin/nvidia-smi",
    reference,
    ...observationArgs,
  ];
}

const DENIAL_EXPECTATIONS: Record<
  (typeof CUA_QUALIFICATION_DENIALS)[number],
  Pick<CuaFailure, "operation" | "family" | "retryable"> & {
    component: CuaFailure["component"] | null;
  }
> = {
  "target-adapter-substitution": {
    operation: "target.health",
    family: "validation_failed",
    retryable: false,
    component: "target",
  },
  "task-adapter-substitution": {
    operation: "task.status",
    family: "validation_failed",
    retryable: false,
    component: null,
  },
  "security-adapter-substitution": {
    operation: "security.verify",
    family: "validation_failed",
    retryable: false,
    component: "runtime",
  },
  "policy-boundary-violation": {
    operation: "security.verify",
    family: "policy_invalid",
    retryable: false,
    component: "policy",
  },
};

function denialOutcomeDigest(id: (typeof CUA_QUALIFICATION_DENIALS)[number]): string {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify({ id, ...DENIAL_EXPECTATIONS[id] }))
    .digest("hex")}`;
}

export function getCuaQualificationDenialOutcomeDigest(
  id: (typeof CUA_QUALIFICATION_DENIALS)[number],
): string {
  return denialOutcomeDigest(id);
}

/** Bind a concrete public fail-closed result to its content-free receipt identity. */
export function assertCuaQualificationDenialBinding(
  receipt: CuaQualificationReceipt,
  id: (typeof CUA_QUALIFICATION_DENIALS)[number],
  value: unknown,
): CuaFailure {
  const record = parseCuaLifecycleRecord(value);
  const expected = DENIAL_EXPECTATIONS[id];
  if (
    record.kind !== "failure" ||
    record.operation !== expected.operation ||
    record.family !== expected.family ||
    record.retryable !== expected.retryable ||
    (record.component ?? null) !== expected.component
  ) {
    throw new Error(`${id} did not produce the required fail-closed public outcome`);
  }
  const binding = receipt.denials.find((entry) => entry.id === id);
  if (!binding || binding.outcomeDigest !== denialOutcomeDigest(id)) {
    throw new Error(`${id} public outcome does not match the qualification receipt`);
  }
  return record;
}

/** Require Docker to have resolved the exact immutable probe image reference. */
export function assertCuaQualificationProbeImageReference(
  reference: string,
  repoDigestsValue: unknown,
): string {
  if (
    reference.length > 4096 ||
    !IMMUTABLE_IMAGE_REFERENCE.test(reference) ||
    !Array.isArray(repoDigestsValue) ||
    repoDigestsValue.length < 1 ||
    repoDigestsValue.length > 64 ||
    repoDigestsValue.some(
      (value) =>
        typeof value !== "string" || value.length > 4096 || !IMMUTABLE_IMAGE_REFERENCE.test(value),
    ) ||
    !repoDigestsValue.includes(reference)
  ) {
    throw new Error("live probe image does not expose the exact immutable repository digest");
  }
  return reference.slice(reference.lastIndexOf("@") + 1);
}

/**
 * Require every GPU/toolkit identity claimed by the receipt to be observed on
 * the host and require the immutable probe container to observe the same GPU.
 */
export function assertCuaQualificationGpuBindings(
  environment: CuaQualificationEnvironment,
  receipt: CuaQualificationReceipt,
  observations: CuaQualificationGpuObservations,
): void {
  assertRuntimeCuaQualificationBinding(environment, receipt);
  const host = parseGpu(observations.host, "live host GPU identity");
  const probeRecord = object(observations.probe, "live probe GPU identity");
  exactKeys(
    probeRecord,
    ["count", "model", "driverVersion", "cudaVersion", "probeImageDigest"],
    "live probe GPU identity",
  );
  const probe = {
    count: positiveGpuCount(probeRecord.count, "live probe GPU identity.count"),
    model: safeValue(probeRecord.model, "live probe GPU identity.model"),
    driverVersion: safeValue(probeRecord.driverVersion, "live probe GPU identity.driverVersion"),
    cudaVersion: safeValue(probeRecord.cudaVersion, "live probe GPU identity.cudaVersion"),
    probeImageDigest: digest(
      probeRecord.probeImageDigest,
      "live probe GPU identity.probeImageDigest",
    ),
  };

  for (const key of [
    "count",
    "model",
    "driverVersion",
    "cudaVersion",
    "containerToolkitVersion",
    "probeImageDigest",
  ] as const) {
    if (environment.gpu[key] !== host[key]) {
      throw new Error(`live host GPU ${key} does not match qualification evidence`);
    }
  }
  for (const key of [
    "count",
    "model",
    "driverVersion",
    "cudaVersion",
    "probeImageDigest",
  ] as const) {
    if (host[key] !== probe[key]) {
      throw new Error(`live probe GPU ${key} does not match the host observation`);
    }
  }
}

function sameInference(actual: CuaInferenceIdentity, expected: CuaInferenceIdentity): boolean {
  return (
    actual.provider === expected.provider &&
    actual.model === expected.model &&
    actual.routeDigest === expected.routeDigest
  );
}

function exactOperations(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    [...actual].sort().join("\0") === [...expected].sort().join("\0")
  );
}

export interface CuaQualificationScenarioExecutionBinding {
  scenario: (typeof CUA_QUALIFICATION_SCENARIOS)[number];
  taskId: string;
  sandboxName: string;
  targetIdentityDigest: string;
  runtimeReadinessDigest: string;
}

export interface CuaQualificationFixtureState {
  schemaVersion: "1.0.0";
  kind: "cua-qualification-fixture-state";
  scenario: (typeof CUA_QUALIFICATION_SCENARIOS)[number];
  taskId: string;
  sandboxName: string;
  targetIdentityDigest: string;
  runtimeReadinessDigest: string;
  fixtureStateDigest: string;
}

export interface CuaQualificationOracleObservation {
  schemaVersion: "1.0.0";
  kind: "cua-qualification-oracle-observation";
  scenario: (typeof CUA_QUALIFICATION_SCENARIOS)[number];
  taskId: string;
  sandboxName: string;
  targetIdentityDigest: string;
  runtimeReadinessDigest: string;
  stateDigest: string;
  evidenceDigests: string[];
}

function qualificationScenario(value: unknown, label: string) {
  const scenario = safeValue(value, label, SAFE_ID);
  if (
    !CUA_QUALIFICATION_SCENARIOS.includes(scenario as (typeof CUA_QUALIFICATION_SCENARIOS)[number])
  ) {
    throw new Error(`${label} is unsupported`);
  }
  return scenario as (typeof CUA_QUALIFICATION_SCENARIOS)[number];
}

function validateScenarioExecutionBinding(
  binding: CuaQualificationScenarioExecutionBinding,
): CuaQualificationScenarioExecutionBinding {
  return {
    scenario: qualificationScenario(binding.scenario, "qualification scenario"),
    taskId: safeValue(binding.taskId, "qualification taskId", SAFE_ID),
    sandboxName: safeValue(binding.sandboxName, "qualification sandboxName", SAFE_ID),
    targetIdentityDigest: digest(
      binding.targetIdentityDigest,
      "qualification targetIdentityDigest",
    ),
    runtimeReadinessDigest: digest(
      binding.runtimeReadinessDigest,
      "qualification runtimeReadinessDigest",
    ),
  };
}

/**
 * Public, content-free fixture executable protocol. The pinned executable is
 * invoked directly (no shell) with this exact argv. It receives no expected
 * fixture or final-state digest. The fixed task-input path names the sealed
 * copy created inside the artifact runner's private root.
 */
export function buildCuaQualificationFixtureArgs(
  binding: CuaQualificationScenarioExecutionBinding,
): string[] {
  const value = validateScenarioExecutionBinding(binding);
  return [
    "prepare",
    "--protocol",
    "cua.qualification.fixture/v1",
    "--scenario",
    value.scenario,
    "--task-id",
    value.taskId,
    "--sandbox",
    value.sandboxName,
    "--target-identity-digest",
    value.targetIdentityDigest,
    "--runtime-readiness-digest",
    value.runtimeReadinessDigest,
    "--task-input",
    CUA_QUALIFICATION_ISOLATED_TASK_INPUT_PATH,
  ];
}

/**
 * Public, content-free oracle executable protocol. Expected receipt state and
 * evidence never enter argv; the controller compares independently observed
 * stdout with the receipt and public lifecycle result.
 */
export function buildCuaQualificationOracleArgs(
  binding: CuaQualificationScenarioExecutionBinding,
): string[] {
  const value = validateScenarioExecutionBinding(binding);
  return [
    "observe",
    "--protocol",
    "cua.qualification.oracle/v1",
    "--scenario",
    value.scenario,
    "--task-id",
    value.taskId,
    "--sandbox",
    value.sandboxName,
    "--target-identity-digest",
    value.targetIdentityDigest,
    "--runtime-readiness-digest",
    value.runtimeReadinessDigest,
  ];
}

/** Exact credential-free environment exposed to fixture and oracle binaries. */
export function buildCuaQualificationArtifactEnvironment(pathValue: string): NodeJS.ProcessEnv {
  if (
    pathValue.length === 0 ||
    pathValue.length > 4096 ||
    pathValue.includes("\0") ||
    pathValue.split(":").some((entry) => !path.isAbsolute(entry))
  ) {
    throw new Error("qualification artifact PATH must contain bounded absolute entries");
  }
  return Object.freeze({ LANG: "C", LC_ALL: "C", PATH: pathValue });
}

function parseCuaQualificationArtifactJson(stdout: string, label: string): Record<string, unknown> {
  if (
    typeof stdout !== "string" ||
    Buffer.byteLength(stdout, "utf8") === 0 ||
    Buffer.byteLength(stdout, "utf8") > CUA_QUALIFICATION_ARTIFACT_OUTPUT_MAX_BYTES ||
    stdout.includes("\0")
  ) {
    throw new Error(`${label} must be non-empty bounded JSON`);
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`${label} must be strict JSON`);
  }
  return object(value, label);
}

export function parseCuaQualificationFixtureOutput(stdout: string): CuaQualificationFixtureState {
  const value = parseCuaQualificationArtifactJson(stdout, "qualification fixture output");
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "scenario",
      "taskId",
      "sandboxName",
      "targetIdentityDigest",
      "runtimeReadinessDigest",
      "fixtureStateDigest",
    ],
    "qualification fixture output",
  );
  if (value.schemaVersion !== "1.0.0" || value.kind !== "cua-qualification-fixture-state") {
    throw new Error("qualification fixture output has an unsupported protocol identity");
  }
  return {
    schemaVersion: "1.0.0",
    kind: "cua-qualification-fixture-state",
    scenario: qualificationScenario(value.scenario, "qualification fixture output.scenario"),
    taskId: safeValue(value.taskId, "qualification fixture output.taskId", SAFE_ID),
    sandboxName: safeValue(value.sandboxName, "qualification fixture output.sandboxName", SAFE_ID),
    targetIdentityDigest: digest(
      value.targetIdentityDigest,
      "qualification fixture output.targetIdentityDigest",
    ),
    runtimeReadinessDigest: digest(
      value.runtimeReadinessDigest,
      "qualification fixture output.runtimeReadinessDigest",
    ),
    fixtureStateDigest: digest(
      value.fixtureStateDigest,
      "qualification fixture output.fixtureStateDigest",
    ),
  };
}

export function parseCuaQualificationOracleOutput(
  stdout: string,
): CuaQualificationOracleObservation {
  const value = parseCuaQualificationArtifactJson(stdout, "qualification oracle output");
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "scenario",
      "taskId",
      "sandboxName",
      "targetIdentityDigest",
      "runtimeReadinessDigest",
      "stateDigest",
      "evidenceDigests",
    ],
    "qualification oracle output",
  );
  if (value.schemaVersion !== "1.0.0" || value.kind !== "cua-qualification-oracle-observation") {
    throw new Error("qualification oracle output has an unsupported protocol identity");
  }
  if (
    !Array.isArray(value.evidenceDigests) ||
    value.evidenceDigests.length === 0 ||
    value.evidenceDigests.length > CUA_QUALIFICATION_EVIDENCE_DIGEST_MAX
  ) {
    throw new Error("qualification oracle output requires bounded evidence digests");
  }
  const evidenceDigests = value.evidenceDigests.map((entry, index) =>
    digest(entry, `qualification oracle output.evidenceDigests[${String(index)}]`),
  );
  if (new Set(evidenceDigests).size !== evidenceDigests.length) {
    throw new Error("qualification oracle output contains duplicate evidence digests");
  }
  const stateDigest = digest(value.stateDigest, "qualification oracle output.stateDigest");
  if (!evidenceDigests.includes(stateDigest)) {
    throw new Error("qualification oracle state digest must be included in evidence digests");
  }
  return {
    schemaVersion: "1.0.0",
    kind: "cua-qualification-oracle-observation",
    scenario: qualificationScenario(value.scenario, "qualification oracle output.scenario"),
    taskId: safeValue(value.taskId, "qualification oracle output.taskId", SAFE_ID),
    sandboxName: safeValue(value.sandboxName, "qualification oracle output.sandboxName", SAFE_ID),
    targetIdentityDigest: digest(
      value.targetIdentityDigest,
      "qualification oracle output.targetIdentityDigest",
    ),
    runtimeReadinessDigest: digest(
      value.runtimeReadinessDigest,
      "qualification oracle output.runtimeReadinessDigest",
    ),
    stateDigest,
    evidenceDigests,
  };
}

function outputIdentityMatches(
  output: Pick<
    CuaQualificationFixtureState,
    "scenario" | "taskId" | "sandboxName" | "targetIdentityDigest" | "runtimeReadinessDigest"
  >,
  binding: CuaQualificationScenarioExecutionBinding,
): boolean {
  const expected = validateScenarioExecutionBinding(binding);
  return (
    output.scenario === expected.scenario &&
    output.taskId === expected.taskId &&
    output.sandboxName === expected.sandboxName &&
    output.targetIdentityDigest === expected.targetIdentityDigest &&
    output.runtimeReadinessDigest === expected.runtimeReadinessDigest
  );
}

export function assertCuaQualificationFixtureBinding(
  scenario: CuaQualificationReceipt["scenarios"][number],
  binding: CuaQualificationScenarioExecutionBinding,
  stdout: string,
): CuaQualificationFixtureState {
  const output = parseCuaQualificationFixtureOutput(stdout);
  if (
    !outputIdentityMatches(output, binding) ||
    output.scenario !== scenario.id ||
    output.taskId !== scenario.taskId ||
    output.fixtureStateDigest !== scenario.fixtureStateDigest
  ) {
    throw new Error(
      `scenario ${scenario.id} fixture state does not match the qualification receipt`,
    );
  }
  return output;
}

/**
 * Reject task inputs that inject controller-owned expected observations into
 * either the fixture or task adapter. Raw and `sha256:` forms are forbidden.
 */
export function assertCuaQualificationTaskInputExpectationFree(
  taskInputPath: string,
  receipt: CuaQualificationReceipt,
  forbiddenCoordinates: readonly string[] = [],
): { sha256: string; sizeBytes: number } {
  const input = readBoundedCuaQualificationFile(taskInputPath);
  if (input.bytes.length === 0 || input.bytes.includes(0)) {
    throw new Error("qualification task input must be non-empty UTF-8 text");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  } catch {
    throw new Error("qualification task input must be non-empty UTF-8 text");
  }
  const qualificationScenarios = receipt.scenarios;
  const expectedDigests = new Set(
    qualificationScenarios.flatMap(({ fixtureStateDigest, stateDigest, evidenceDigests }) => [
      fixtureStateDigest,
      stateDigest,
      ...evidenceDigests,
    ]),
  );
  const forbidden = [
    ...[...expectedDigests].flatMap((value) => [value, value.slice("sha256:".length)]),
    ...forbiddenCoordinates.filter(Boolean),
  ];
  if (forbidden.some((value) => text.includes(value))) {
    throw new Error(
      "qualification task input must not contain expected observations or authority coordinates",
    );
  }
  return { sha256: input.sha256, sizeBytes: input.bytes.length };
}

export function assertCuaQualificationScenarioBindings(
  receipt: CuaQualificationReceipt,
  scenario: CuaQualificationReceipt["scenarios"][number],
  taskResultValue: unknown,
): CuaTaskResult {
  const result = parseCuaTaskResult(taskResultValue);
  if (
    result.taskId !== scenario.taskId ||
    result.status !== "succeeded" ||
    result.agentResult.status !== "succeeded" ||
    result.verification.status !== "passed"
  ) {
    throw new Error(`scenario ${scenario.id} public task result did not pass`);
  }
  if (result.agentResult.resultDigest !== scenario.stateDigest) {
    throw new Error(`scenario ${scenario.id} state digest does not match the public task result`);
  }
  for (const [name, expected] of Object.entries({
    openshell: receipt.components.openshell,
    runtime: receipt.components.runtime,
    sandboxImage: receipt.components.sandboxImage,
    targetImage: receipt.components.targetImage,
    serviceBundle: receipt.components.serviceBundle,
    policy: receipt.components.policy,
    taskProtocol: receipt.components.taskProtocol,
  })) {
    componentDigest(
      result.components[name as keyof typeof result.components],
      expected,
      `scenario ${scenario.id} task-result components.${name}`,
    );
  }
  if (!sameInference(result.inference, receipt.inference)) {
    throw new Error(`scenario ${scenario.id} task-result inference does not match the receipt`);
  }

  const resultEvidence = result.evidence.map(({ digest: value }) => value);
  if (!exactOperations(resultEvidence, scenario.evidenceDigests)) {
    throw new Error(`scenario ${scenario.id} evidence digests do not match the public task result`);
  }
  const resultEvidenceSet = new Set(resultEvidence);
  if (!resultEvidenceSet.has(scenario.stateDigest)) {
    throw new Error(`scenario ${scenario.id} state digest is not public task-result evidence`);
  }

  return result;
}

/** Bind independent oracle stdout to the receipt and public task observations. */
export function assertCuaQualificationObservedScenarioBindings(
  receipt: CuaQualificationReceipt,
  scenario: CuaQualificationReceipt["scenarios"][number],
  binding: CuaQualificationScenarioExecutionBinding,
  oracleStdout: string,
  taskResultValue: unknown,
): CuaTaskResult {
  const observation = parseCuaQualificationOracleOutput(oracleStdout);
  if (
    !outputIdentityMatches(observation, binding) ||
    observation.scenario !== scenario.id ||
    observation.taskId !== scenario.taskId ||
    observation.stateDigest !== scenario.stateDigest ||
    !exactOperations(observation.evidenceDigests, scenario.evidenceDigests)
  ) {
    throw new Error(`scenario ${scenario.id} oracle observation does not match the receipt`);
  }
  const result = assertCuaQualificationScenarioBindings(receipt, scenario, taskResultValue);
  const resultEvidence = result.evidence.map(({ digest: value }) => value);
  if (
    result.agentResult.resultDigest !== observation.stateDigest ||
    !exactOperations(resultEvidence, observation.evidenceDigests)
  ) {
    throw new Error(`scenario ${scenario.id} oracle observation does not match the public result`);
  }
  return result;
}

export function assertCuaQualificationEnvironmentBindings(
  environment: CuaQualificationEnvironment,
  receipt: CuaQualificationReceipt,
): void {
  assertRuntimeCuaQualificationBinding(environment, receipt);
}

export function assertCuaCandidateManifestBindings(
  manifest: CuaRuntimeManifest,
  receipt: CuaQualificationReceipt,
): void {
  if (manifest.compatibility.status !== "candidate") {
    throw new Error("CUA runtime manifest is not a qualification candidate");
  }
  if (
    manifest.compatibility.candidateSourceRevision !== receipt.nemoclawCommit ||
    manifest.bundleReceipt.sha256 !== receipt.bundleReceiptSha256
  ) {
    throw new Error(
      "CUA runtime manifest candidate identity does not match qualification evidence",
    );
  }
  if (
    receipt.targetChannel.serviceBundleDigest !== receipt.components.serviceBundle ||
    receipt.targetChannel.serviceBundleDigest !==
      `sha256:${manifest.artifacts.targetServices.sha256}`
  ) {
    throw new Error("targetChannel serviceBundleDigest does not match the runtime manifest");
  }
  if (
    receipt.targetChannel.targetImageDigest !== receipt.components.targetImage ||
    receipt.targetChannel.targetImageDigest !== manifest.artifacts.targetImage.digest
  ) {
    throw new Error("targetChannel targetImageDigest does not match the runtime manifest");
  }
  for (const [actual, expected, label] of [
    [`sha256:${manifest.artifacts.hostCli.sha256}`, receipt.components.runtime, "runtime"],
    [manifest.artifacts.sandboxImage.digest, receipt.components.sandboxImage, "sandboxImage"],
    [
      `sha256:${manifest.artifacts.adapters.target.sha256}`,
      receipt.components.targetAdapter,
      "targetAdapter",
    ],
    [manifest.artifacts.targetImage.digest, receipt.components.targetImage, "targetImage"],
    [
      `sha256:${manifest.artifacts.targetServices.sha256}`,
      receipt.components.serviceBundle,
      "serviceBundle",
    ],
    [`sha256:${manifest.agent.policy.sha256}`, receipt.components.policy, "policy"],
    [
      `sha256:${manifest.artifacts.adapters.task.sha256}`,
      receipt.components.taskProtocol,
      "taskProtocol",
    ],
    [
      `sha256:${manifest.artifacts.adapters.security.sha256}`,
      receipt.components.securityVerifier,
      "securityVerifier",
    ],
  ] as const) {
    if (actual !== expected) throw new Error(`${label} does not match the runtime manifest`);
  }
}

export function assertCuaQualificationTargetManifestBindings(
  value: unknown,
  receipt: CuaQualificationReceipt,
): void {
  const manifest = parseCuaTargetManifest(value);
  componentDigest(manifest.image, receipt.components.targetImage, "targetImage");
  componentDigest(manifest.serviceBundle, receipt.components.serviceBundle, "serviceBundle");
}

export function assertCuaCandidateRuntimeBindings(
  receipt: CuaQualificationReceipt,
  value: unknown,
  bindings: CuaCandidateRuntimeBindings,
): void {
  const runtime = parseCuaRuntimeReadiness(value);
  if (runtime.status !== "candidate") throw new Error("CUA runtime is not a candidate");
  if (
    runtime.agent !== "nemocua" ||
    bindings.sourceClean !== true ||
    !COMMIT.test(bindings.sourceRevision) ||
    bindings.sourceRevision !== receipt.nemoclawCommit ||
    runtime.sourceRevision !== bindings.sourceRevision ||
    runtime.sourceRevision !== receipt.nemoclawCommit ||
    runtime.sourceClean !== true ||
    runtime.runtimeManifestDigest !== bindings.runtimeManifestDigest ||
    runtime.qualification?.state !== "candidate" ||
    runtime.qualification.environmentDigest !== bindings.environmentDigest ||
    runtime.qualification.bundleReceiptDigest !== bindings.bundleReceiptDigest
  ) {
    throw new Error("CUA candidate source or qualification identity does not match the receipt");
  }
  if (!sameInference(runtime.inference, receipt.inference)) {
    throw new Error("CUA inference identity does not match the receipt");
  }
  if (
    !exactOperations(runtime.targetOperations, CUA_TARGET_OPERATIONS) ||
    !exactOperations(runtime.taskOperations, CUA_TASK_OPERATIONS) ||
    !exactOperations(runtime.securityOperations, CUA_SECURITY_OPERATIONS)
  ) {
    throw new Error("CUA candidate advertises an unsupported lifecycle operation set");
  }
  componentDigest(runtime.components.openshell, receipt.components.openshell, "openshell");
  componentDigest(runtime.components.runtime, receipt.components.runtime, "runtime");
  componentDigest(runtime.components.sandboxImage, receipt.components.sandboxImage, "sandboxImage");
  componentDigest(
    runtime.components.targetAdapter,
    receipt.components.targetAdapter,
    "targetAdapter",
  );
  componentDigest(runtime.components.policy, receipt.components.policy, "policy");
  componentDigest(runtime.components.taskProtocol, receipt.components.taskProtocol, "taskProtocol");
  componentDigest(
    runtime.components.securityVerifier,
    receipt.components.securityVerifier,
    "securityVerifier",
  );
}

export function assertCuaQualificationStatusBindings(
  receipt: CuaQualificationReceipt,
  value: unknown,
  bindings: CuaCandidateRuntimeBindings,
): void {
  const status = object(value, "sandbox status");
  const runtime = parseCuaRuntimeReadiness(status.cuaRuntime);
  const target = parseCuaTargetAttachment(status.cuaTarget);
  const security = parseCuaSecurityAttestation(status.cuaSecurity);
  assertCuaCandidateRuntimeBindings(receipt, runtime, bindings);
  if (target.status !== "attached" || !target.target) throw new Error("CUA target is not attached");
  if (security.status !== "enforced") throw new Error("CUA security is not enforced");
  componentDigest(target.target.image, receipt.components.targetImage, "targetImage");
  componentDigest(target.target.serviceBundle, receipt.components.serviceBundle, "serviceBundle");

  const readinessDigest = getCuaRuntimeReadinessDigest(runtime);
  if (
    target.runtimeReadinessDigest !== readinessDigest ||
    security.bindings.runtimeReadinessDigest !== readinessDigest ||
    security.bindings.targetIdentityDigest !== target.target.identityDigest ||
    !sameInference(security.bindings.inference, receipt.inference)
  ) {
    throw new Error(
      "CUA target, security, or inference state is not bound to current runtime readiness",
    );
  }
  for (const [name, expected] of Object.entries({
    runtime: receipt.components.runtime,
    sandboxImage: receipt.components.sandboxImage,
    targetImage: receipt.components.targetImage,
    serviceBundle: receipt.components.serviceBundle,
    policy: receipt.components.policy,
    taskProtocol: receipt.components.taskProtocol,
  })) {
    componentDigest(
      security.bindings.components[name as keyof typeof security.bindings.components],
      expected,
      `security.bindings.components.${name}`,
    );
  }
  componentDigest(security.verifier, receipt.components.securityVerifier, "security.verifier");
}

export function assertCuaReleaseBundleBindings(
  bundle: CuaReleaseBundleReceipt,
  receipt: CuaQualificationReceipt,
): void {
  if (`sha256:${bundle.artifacts.cli.sha256}` !== receipt.components.runtime) {
    throw new Error("runtime does not match the pinned CUA CLI archive");
  }
  if (`sha256:${bundle.artifacts.services.sha256}` !== receipt.components.serviceBundle) {
    throw new Error("serviceBundle does not match the pinned CUA target-services archive");
  }
  if (bundle.artifacts.image.manifestDigest !== receipt.components.targetImage) {
    throw new Error("targetImage does not match the pinned NVLumina manifest digest");
  }
}
