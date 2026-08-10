// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readBoundedRegularFile } from "./bounded-file";
import {
  CUA_RUNTIME_MANIFEST_ENV,
  CUA_RUNTIME_MANIFEST_SHA256_ENV,
  CUA_SANDBOX_IMAGE_ENV,
  requireCuaFrameworkEnabled,
} from "./feature";
import { CUA_HOST_COORDINATE, CUA_SENSITIVE_VALUE } from "./shared-primitives";

const yaml: { load(input: string): unknown } = require("js-yaml");

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PAYLOAD_BYTES = 8 * 1024 ** 3;
const MAX_AGENT_MANIFEST_BYTES = 256 * 1024;
const MAX_DOCKERFILE_BYTES = 1024 * 1024;
const MAX_POLICY_BYTES = 1024 * 1024;
const MAX_ADAPTER_BYTES = 4 * 1024 * 1024;
const RAW_DIGEST = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SAFE_COMMAND_ARG = /^[A-Za-z0-9_./:=+,-]{1,128}$/;
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

export interface CuaPayloadFileIdentity {
  filename: string;
  sizeBytes: number;
  sha256: string;
}

export interface CuaArchiveArtifactIdentity extends CuaPayloadFileIdentity {
  name: string;
  version: string;
}

export interface CuaImageArtifactIdentity {
  name: string;
  version: string;
  platform: "linux/amd64";
  digest: string;
}

export interface CuaAdapterArtifactIdentity extends CuaPayloadFileIdentity {
  name: string;
  version: string;
}

export interface CuaRuntimeCompatibility {
  status: "candidate";
  issue: 7755;
  candidateSourceRevision: string;
}

export interface CuaRuntimeManifest {
  schemaVersion: "1.0.0";
  kind: "cua-runtime-manifest";
  agent: {
    name: "nemocua";
    manifest: CuaPayloadFileIdentity;
    dockerfile: CuaPayloadFileIdentity;
    baseDockerfile: CuaPayloadFileIdentity;
    policy: CuaPayloadFileIdentity;
  };
  compatibility: CuaRuntimeCompatibility;
  bundleReceipt: {
    schema: "cua.release.bundle/v1";
    releaseId: string;
    producerCommit: string;
    sha256: string;
  };
  artifacts: {
    hostCli: CuaArchiveArtifactIdentity;
    sandboxImage: CuaImageArtifactIdentity;
    targetImage: CuaImageArtifactIdentity;
    targetServices: CuaArchiveArtifactIdentity;
    adapters: {
      target: CuaAdapterArtifactIdentity;
      task: CuaAdapterArtifactIdentity;
      security: CuaAdapterArtifactIdentity;
    };
  };
  qualificationEvidence: null;
}

export interface LoadedCuaRuntimeManifest {
  path: string;
  root: string;
  sha256: string;
  manifest: CuaRuntimeManifest;
  assertFileOwnership: CuaAuthorityFileOwnershipValidator;
}

export type CuaAuthorityFileOwnershipValidator = (filePath: string, label: string) => void;

export interface CuaRuntimeManifestValidationOptions {
  assertFileOwnership?: CuaAuthorityFileOwnershipValidator;
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

export function assertCuaAuthorityFileOwnership(filePath: string, label: string): void {
  const effectiveUid = process.geteuid?.();
  if (effectiveUid === undefined) {
    throw new Error(`${label} ownership validation requires a POSIX host`);
  }
  const hasTrustedOwner = (uid: number): boolean => uid === 0 || uid === effectiveUid;
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !hasTrustedOwner(stat.uid) ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error(
      `${label} must be a root- or process-owned regular file without group/world write access`,
    );
  }
  const parent = fs.lstatSync(path.dirname(filePath));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    !hasTrustedOwner(parent.uid) ||
    (parent.mode & 0o022) !== 0
  ) {
    throw new Error(
      `${label} parent must be a root- or process-owned directory without group/world write access`,
    );
  }
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`${label}.${key} must be a non-empty bounded string`);
  }
  return value;
}

function safeIdentity(record: Record<string, unknown>, key: string, label: string): string {
  const value = requiredString(record, key, label);
  if (!SAFE_ID.test(value) || CUA_SENSITIVE_VALUE.test(value) || CUA_HOST_COORDINATE.test(value)) {
    throw new Error(`${label}.${key} must be a coordinate- and credential-free identity`);
  }
  return value;
}

function rawDigest(record: Record<string, unknown>, key: string, label: string): string {
  const value = requiredString(record, key, label);
  if (!RAW_DIGEST.test(value)) throw new Error(`${label}.${key} must be a lowercase SHA-256`);
  return value;
}

function exactCommit(record: Record<string, unknown>, key: string, label: string): string {
  const value = requiredString(record, key, label);
  if (!COMMIT.test(value)) throw new Error(`${label}.${key} must be an exact lowercase commit`);
  return value;
}

function sizeBytes(record: Record<string, unknown>, label: string, maxBytes: number): number {
  const value = record.sizeBytes;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maxBytes) {
    throw new Error(`${label}.sizeBytes must be from 1 through ${String(maxBytes)}`);
  }
  return Number(value);
}

function payloadFile(
  value: unknown,
  label: string,
  maxBytes = MAX_PAYLOAD_BYTES,
): CuaPayloadFileIdentity {
  const record = object(value, label);
  exactKeys(record, ["filename", "sizeBytes", "sha256"], label);
  const filename = requiredString(record, "filename", label);
  if (
    !SAFE_FILENAME.test(filename) ||
    path.basename(filename) !== filename ||
    CUA_SENSITIVE_VALUE.test(filename) ||
    CUA_HOST_COORDINATE.test(filename)
  ) {
    throw new Error(`${label}.filename must be one safe basename`);
  }
  return {
    filename,
    sizeBytes: sizeBytes(record, label, maxBytes),
    sha256: rawDigest(record, "sha256", label),
  };
}

function archiveArtifact(value: unknown, label: string): CuaArchiveArtifactIdentity {
  const record = object(value, label);
  exactKeys(record, ["name", "version", "filename", "sizeBytes", "sha256"], label);
  const file = payloadFile(
    {
      filename: record.filename,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
    },
    label,
  );
  return {
    name: safeIdentity(record, "name", label),
    version: safeIdentity(record, "version", label),
    ...file,
  };
}

function adapterArtifact(value: unknown, label: string): CuaAdapterArtifactIdentity {
  const record = object(value, label);
  exactKeys(record, ["name", "version", "filename", "sizeBytes", "sha256"], label);
  return {
    name: safeIdentity(record, "name", label),
    version: safeIdentity(record, "version", label),
    ...payloadFile(
      {
        filename: record.filename,
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
      },
      label,
      MAX_ADAPTER_BYTES,
    ),
  };
}

function imageArtifact(value: unknown, label: string): CuaImageArtifactIdentity {
  const record = object(value, label);
  exactKeys(record, ["name", "version", "platform", "digest"], label);
  const digest = requiredString(record, "digest", label);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`${label}.digest must be a sha256 digest`);
  }
  if (record.platform !== "linux/amd64") {
    throw new Error(`${label}.platform must be linux/amd64`);
  }
  return {
    name: safeIdentity(record, "name", label),
    version: safeIdentity(record, "version", label),
    platform: "linux/amd64",
    digest,
  };
}

function compatibility(value: unknown): CuaRuntimeCompatibility {
  const record = object(value, "compatibility");
  if (record.status === "candidate") {
    exactKeys(record, ["status", "issue", "candidateSourceRevision"], "compatibility");
    if (record.issue !== 7755) throw new Error("compatibility.issue must be 7755");
    return {
      status: "candidate",
      issue: 7755,
      candidateSourceRevision: exactCommit(record, "candidateSourceRevision", "compatibility"),
    };
  }
  throw new Error("compatibility.status must be candidate");
}

export function parseCuaRuntimeManifest(value: unknown): CuaRuntimeManifest {
  const record = object(value, "CUA runtime manifest");
  exactKeys(
    record,
    [
      "schemaVersion",
      "kind",
      "agent",
      "compatibility",
      "bundleReceipt",
      "artifacts",
      "qualificationEvidence",
    ],
    "CUA runtime manifest",
  );
  if (record.schemaVersion !== "1.0.0" || record.kind !== "cua-runtime-manifest") {
    throw new Error("CUA runtime manifest must use cua-runtime-manifest schema 1.0.0");
  }

  const agent = object(record.agent, "agent");
  exactKeys(agent, ["name", "manifest", "dockerfile", "baseDockerfile", "policy"], "agent");
  if (agent.name !== "nemocua") throw new Error("CUA runtime manifest agent must be nemocua");

  const bundle = object(record.bundleReceipt, "bundleReceipt");
  exactKeys(bundle, ["schema", "releaseId", "producerCommit", "sha256"], "bundleReceipt");
  if (bundle.schema !== "cua.release.bundle/v1") {
    throw new Error("bundleReceipt.schema must be cua.release.bundle/v1");
  }

  const artifacts = object(record.artifacts, "artifacts");
  exactKeys(
    artifacts,
    ["hostCli", "sandboxImage", "targetImage", "targetServices", "adapters"],
    "artifacts",
  );
  const adapters = object(artifacts.adapters, "artifacts.adapters");
  exactKeys(adapters, ["target", "task", "security"], "artifacts.adapters");
  const parsedCompatibility = compatibility(record.compatibility);

  if (record.qualificationEvidence !== null) {
    throw new Error("qualificationEvidence must be absent for candidate");
  }

  const result: CuaRuntimeManifest = {
    schemaVersion: "1.0.0",
    kind: "cua-runtime-manifest",
    agent: {
      name: "nemocua",
      manifest: payloadFile(agent.manifest, "agent.manifest", MAX_AGENT_MANIFEST_BYTES),
      dockerfile: payloadFile(agent.dockerfile, "agent.dockerfile", MAX_DOCKERFILE_BYTES),
      baseDockerfile: payloadFile(
        agent.baseDockerfile,
        "agent.baseDockerfile",
        MAX_DOCKERFILE_BYTES,
      ),
      policy: payloadFile(agent.policy, "agent.policy", MAX_POLICY_BYTES),
    },
    compatibility: parsedCompatibility,
    bundleReceipt: {
      schema: "cua.release.bundle/v1",
      releaseId: safeIdentity(bundle, "releaseId", "bundleReceipt"),
      producerCommit: exactCommit(bundle, "producerCommit", "bundleReceipt"),
      sha256: rawDigest(bundle, "sha256", "bundleReceipt"),
    },
    artifacts: {
      hostCli: archiveArtifact(artifacts.hostCli, "artifacts.hostCli"),
      sandboxImage: imageArtifact(artifacts.sandboxImage, "artifacts.sandboxImage"),
      targetImage: imageArtifact(artifacts.targetImage, "artifacts.targetImage"),
      targetServices: archiveArtifact(artifacts.targetServices, "artifacts.targetServices"),
      adapters: {
        target: adapterArtifact(adapters.target, "artifacts.adapters.target"),
        task: adapterArtifact(adapters.task, "artifacts.adapters.task"),
        security: adapterArtifact(adapters.security, "artifacts.adapters.security"),
      },
    },
    qualificationEvidence: null,
  };

  for (const [field, actual, expected] of [
    ["agent.manifest.filename", result.agent.manifest.filename, "manifest.yaml"],
    ["agent.dockerfile.filename", result.agent.dockerfile.filename, "Dockerfile"],
    ["agent.baseDockerfile.filename", result.agent.baseDockerfile.filename, "Dockerfile.base"],
    ["agent.policy.filename", result.agent.policy.filename, "policy-additions.yaml"],
  ] as const) {
    if (actual !== expected) throw new Error(`${field} must be ${expected}`);
  }

  const filenames = [
    result.agent.manifest,
    result.agent.dockerfile,
    result.agent.baseDockerfile,
    result.agent.policy,
    result.artifacts.hostCli,
    result.artifacts.targetServices,
    result.artifacts.adapters.target,
    result.artifacts.adapters.task,
    result.artifacts.adapters.security,
  ].map((identity) => identity.filename);
  if (new Set(filenames).size !== filenames.length) {
    throw new Error("CUA runtime manifest payload filenames must be unique");
  }
  return result;
}

function expectedManifestSha256(env: NodeJS.ProcessEnv): string {
  const value = env[CUA_RUNTIME_MANIFEST_SHA256_ENV]?.trim() ?? "";
  if (!RAW_DIGEST.test(value)) {
    throw new Error(`${CUA_RUNTIME_MANIFEST_SHA256_ENV} must be a lowercase SHA-256`);
  }
  return value;
}

export function loadCuaRuntimeManifest(
  env: NodeJS.ProcessEnv = process.env,
  options: CuaRuntimeManifestValidationOptions = {},
): LoadedCuaRuntimeManifest {
  requireCuaFrameworkEnabled(env);
  const configuredPath = env[CUA_RUNTIME_MANIFEST_ENV]?.trim() ?? "";
  if (!path.isAbsolute(configuredPath)) {
    throw new Error(`${CUA_RUNTIME_MANIFEST_ENV} must be an absolute path`);
  }
  const assertFileOwnership = options.assertFileOwnership ?? assertCuaAuthorityFileOwnership;
  assertFileOwnership(configuredPath, "CUA runtime manifest");
  const raw = readBoundedRegularFile(configuredPath, {
    label: "CUA runtime manifest",
    minBytes: 2,
    maxBytes: MAX_MANIFEST_BYTES,
  });
  const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
  if (sha256 !== expectedManifestSha256(env)) {
    throw new Error("CUA runtime manifest does not match its expected content identity");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new Error("CUA runtime manifest must contain strict JSON");
  }
  return {
    path: configuredPath,
    root: path.dirname(configuredPath),
    sha256,
    manifest: parseCuaRuntimeManifest(value),
    assertFileOwnership,
  };
}

function verifyPayloadFile(
  root: string,
  identity: CuaPayloadFileIdentity,
  label: string,
  assertFileOwnership: CuaAuthorityFileOwnershipValidator,
): string {
  const filePath = path.join(root, identity.filename);
  assertFileOwnership(filePath, label);
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size !== BigInt(identity.sizeBytes)) {
      throw new Error(`${label} does not match its declared size`);
    }
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > identity.sizeBytes) throw new Error(`${label} changed during validation`);
      hash.update(buffer.subarray(0, read));
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      total !== identity.sizeBytes ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      hash.digest("hex") !== identity.sha256
    ) {
      throw new Error(`${label} does not match its declared content identity`);
    }
    return filePath;
  } finally {
    fs.closeSync(descriptor);
  }
}

function copyVerifiedPayloadFile(
  root: string,
  identity: CuaPayloadFileIdentity,
  destination: string,
  label: string,
  assertFileOwnership: CuaAuthorityFileOwnershipValidator,
): void {
  const sourcePath = path.join(root, identity.filename);
  assertFileOwnership(sourcePath, label);
  const source = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let output: number | undefined;
  try {
    const before = fs.fstatSync(source, { bigint: true });
    if (!before.isFile() || before.size !== BigInt(identity.sizeBytes)) {
      throw new Error(`${label} does not match its declared size`);
    }
    output = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      Number(before.mode & 0o777n),
    );
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const bytesRead = fs.readSync(source, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > identity.sizeBytes) throw new Error(`${label} changed during staging`);
      hash.update(buffer.subarray(0, bytesRead));
      let offset = 0;
      while (offset < bytesRead) {
        offset += fs.writeSync(output, buffer, offset, bytesRead - offset);
      }
    }
    fs.fsyncSync(output);
    const after = fs.fstatSync(source, { bigint: true });
    if (
      total !== identity.sizeBytes ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      hash.digest("hex") !== identity.sha256
    ) {
      throw new Error(`${label} changed or failed its content identity during staging`);
    }
  } catch (error) {
    if (output !== undefined) {
      fs.closeSync(output);
      output = undefined;
    }
    try {
      fs.rmSync(destination, { force: true });
    } catch {
      // Preserve the authority failure; the temporary build context is cleaned by its owner.
    }
    throw error;
  } finally {
    if (output !== undefined) fs.closeSync(output);
    fs.closeSync(source);
  }
}

function manifestString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    CONTROL_CHARACTER.test(value) ||
    CUA_HOST_COORDINATE.test(value) ||
    CUA_SENSITIVE_VALUE.test(value)
  ) {
    throw new Error(`${label}.${key} must be bounded, printable, coordinate- and credential-free`);
  }
  return value;
}

function manifestCommand(
  record: Record<string, unknown>,
  key: string,
  label: string,
  binary: string,
): string {
  const command = manifestString(record, key, label);
  const argv = command.split(" ");
  if (
    command !== argv.join(" ") ||
    argv.length < 1 ||
    argv.length > 16 ||
    argv[0] !== binary ||
    argv.some(
      (argument) =>
        !SAFE_COMMAND_ARG.test(argument) ||
        argument.split("/").some((segment) => segment === "." || segment === ".."),
    )
  ) {
    throw new Error(
      `${label}.${key} must use the declared binary and a closed, canonical argument grammar`,
    );
  }
  return command;
}

/** Validate the Launchable-provided YAML before it enters ordinary agent loading. */
export function validateExternalCuaAgentManifest(raw: Buffer): void {
  let parsed: unknown;
  try {
    parsed = yaml.load(raw.toString("utf8"));
  } catch {
    throw new Error("External NemoCUA agent manifest must contain strict YAML");
  }
  const record = object(parsed, "external NemoCUA agent manifest");
  exactKeys(
    record,
    [
      "name",
      "display_name",
      "description",
      "binary_path",
      "version_command",
      "expected_version",
      "version_scheme",
      "runtime",
      "config",
      "state_dirs",
      "device_pairing",
      "inference",
      "mcp",
    ],
    "external NemoCUA agent manifest",
  );
  if (record.name !== "nemocua" || record.display_name !== "NemoCUA") {
    throw new Error("External NemoCUA agent manifest must identify nemocua and NemoCUA");
  }
  manifestString(record, "description", "external NemoCUA agent manifest");
  const binaryPath = manifestString(record, "binary_path", "external NemoCUA agent manifest");
  if (!/^\/(?:usr\/local\/bin|opt\/[A-Za-z0-9._-]+\/bin)\/[A-Za-z0-9._+-]+$/.test(binaryPath)) {
    throw new Error("External NemoCUA binary_path must be a canonical sandbox binary path");
  }
  const binary = path.basename(binaryPath);
  if (binary !== "nemocua") {
    throw new Error("External NemoCUA binary_path must name the canonical nemocua executable");
  }
  const versionCommand = manifestCommand(
    record,
    "version_command",
    "external NemoCUA agent manifest",
    binary,
  );
  if (versionCommand !== "nemocua version") {
    throw new Error("External NemoCUA version_command must be exactly 'nemocua version'");
  }
  manifestString(record, "expected_version", "external NemoCUA agent manifest");
  if (record.version_scheme !== "semver" || record.device_pairing !== false) {
    throw new Error("External NemoCUA must use semver and disable device pairing");
  }

  const runtime = object(record.runtime, "external NemoCUA runtime");
  exactKeys(
    runtime,
    ["kind", "interactive_command", "headless_command", "smoke_commands"],
    "external NemoCUA runtime",
  );
  if (runtime.kind !== "terminal") throw new Error("External NemoCUA runtime must be terminal");
  const exactRuntimeCommands = {
    interactive_command: "nemocua interactive",
    headless_command: "nemocua headless",
  } as const;
  for (const key of ["interactive_command", "headless_command"] as const) {
    const command = manifestCommand(runtime, key, "external NemoCUA runtime", binary);
    if (command !== exactRuntimeCommands[key]) {
      throw new Error(`External NemoCUA ${key} must be exactly '${exactRuntimeCommands[key]}'`);
    }
  }
  if (
    !Array.isArray(runtime.smoke_commands) ||
    runtime.smoke_commands.length < 1 ||
    runtime.smoke_commands.length > 8
  ) {
    throw new Error("External NemoCUA smoke_commands must contain 1 through 8 commands");
  }
  for (const [index, command] of runtime.smoke_commands.entries()) {
    if (typeof command !== "string") {
      throw new Error(`External NemoCUA smoke_commands[${String(index)}] must be a string`);
    }
    manifestCommand(
      { command },
      "command",
      `external NemoCUA smoke_commands[${String(index)}]`,
      binary,
    );
  }

  const config = object(record.config, "external NemoCUA config");
  exactKeys(config, ["dir", "config_file", "format"], "external NemoCUA config");
  const configDir = manifestString(config, "dir", "external NemoCUA config");
  const configFile = manifestString(config, "config_file", "external NemoCUA config");
  const configSegments = configDir.slice("/sandbox/".length).split("/");
  if (
    !/^\/sandbox\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(configDir) ||
    configSegments.some((segment) => segment === "." || segment === "..") ||
    !SAFE_FILENAME.test(configFile)
  ) {
    throw new Error("External NemoCUA config paths must stay inside /sandbox");
  }
  if (!SAFE_ID.test(manifestString(config, "format", "external NemoCUA config"))) {
    throw new Error("External NemoCUA config.format is invalid");
  }

  if (!Array.isArray(record.state_dirs) || record.state_dirs.length > 32) {
    throw new Error("External NemoCUA state_dirs must be a bounded list");
  }
  for (const [index, value] of record.state_dirs.entries()) {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value) ||
      value.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      throw new Error(`External NemoCUA state_dirs[${String(index)}] is invalid`);
    }
  }

  const inference = object(record.inference, "external NemoCUA inference");
  exactKeys(
    inference,
    ["provider_type", "default_model", "proxy_support"],
    "external NemoCUA inference",
  );
  if (inference.provider_type !== "openai_compatible" || inference.proxy_support !== "implicit") {
    throw new Error("External NemoCUA must use managed OpenAI-compatible inference");
  }
  const model = manifestString(inference, "default_model", "external NemoCUA inference");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,7}$/.test(model)) {
    throw new Error("External NemoCUA inference.default_model is invalid");
  }
  const mcp = object(record.mcp, "external NemoCUA mcp");
  exactKeys(mcp, ["support", "reason"], "external NemoCUA mcp");
  if (mcp.support !== "disabled") throw new Error("External NemoCUA MCP support must be disabled");
  manifestString(mcp, "reason", "external NemoCUA mcp");
}

function assertSingleBoundDockerfileBase(
  dockerfile: string,
  options: {
    argument: string;
    expectedArgument: RegExp;
    expectedFrom: RegExp;
    error: string;
  },
): void {
  const escapedArgument = options.argument.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundArgumentInstructions =
    dockerfile.match(
      new RegExp(`^[\\t ]*ARG[\\t ]+${escapedArgument}(?:[\\t ]*=.*)?[\\t ]*$`, "gim"),
    ) ?? [];
  const argumentInstructions = dockerfile.match(/^[\t ]*ARG(?:[\t ]|$).*$/gim) ?? [];
  const fromInstructions = dockerfile.match(/^[\t ]*FROM(?:[\t ]|$).*$/gim) ?? [];
  if (
    (dockerfile.match(options.expectedArgument) ?? []).length !== 1 ||
    boundArgumentInstructions.length !== 1 ||
    argumentInstructions.length !== 1 ||
    (dockerfile.match(options.expectedFrom) ?? []).length !== 1 ||
    fromInstructions.length !== 1
  ) {
    throw new Error(options.error);
  }
}

const CLOSED_DOCKERFILE_METADATA_INSTRUCTIONS = new Set([
  "ARG",
  "CMD",
  "ENTRYPOINT",
  "ENV",
  "EXPOSE",
  "FROM",
  "HEALTHCHECK",
  "LABEL",
  "SHELL",
  "STOPSIGNAL",
  "USER",
  "VOLUME",
  "WORKDIR",
]);
const DOCKERFILE_PARSER_DIRECTIVE = /^#\s*(?:check|escape|syntax)\s*=/i;
const DOCKERFILE_LINE_CONTROL_CHARACTER = /[\x00-\x08\x0b-\x1f\x7f]/;
const CLOSED_COPY_TOKEN = /^[A-Za-z0-9_./:+-]+$/;

function assertClosedDockerfileBuildInputs(
  dockerfile: string,
  options: {
    label: string;
    allowedCopySources: ReadonlySet<string>;
  },
): void {
  if (dockerfile.includes("\r")) {
    throw new Error(`${options.label} must use unambiguous LF-delimited instructions`);
  }

  for (const [index, line] of dockerfile.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (DOCKERFILE_LINE_CONTROL_CHARACTER.test(line) || line.trimEnd().endsWith("\\")) {
      throw new Error(
        `${options.label} instruction ${String(index + 1)} uses an unsupported continuation or control character`,
      );
    }
    if (trimmed.startsWith("#")) {
      if (DOCKERFILE_PARSER_DIRECTIVE.test(trimmed)) {
        throw new Error(`${options.label} cannot select a Dockerfile parser frontend`);
      }
      continue;
    }

    const match = /^[\t ]*([A-Za-z]+)[\t ]+(.+?)[\t ]*$/.exec(line);
    if (!match) {
      throw new Error(`${options.label} instruction ${String(index + 1)} is ambiguous`);
    }
    const instruction = match[1].toUpperCase();
    const body = match[2];

    if (instruction === "ADD") {
      throw new Error(`${options.label} cannot use ADD`);
    }
    if (instruction === "COPY") {
      const tokens = body.split(/[\t ]+/);
      if (
        tokens.length !== 2 ||
        tokens.some((token) => !CLOSED_COPY_TOKEN.test(token)) ||
        !options.allowedCopySources.has(tokens[0])
      ) {
        throw new Error(
          `${options.label} COPY must name one exact manifest-bound staged agents/nemocua payload`,
        );
      }
      continue;
    }
    if (instruction === "RUN") {
      const offline = /^--network=none[\t ]+(.+)$/.exec(body);
      if (!offline || offline[1].trimStart().startsWith("--")) {
        throw new Error(
          `${options.label} RUN must use only the canonical BuildKit --network=none option`,
        );
      }
      continue;
    }
    if (!CLOSED_DOCKERFILE_METADATA_INSTRUCTIONS.has(instruction)) {
      throw new Error(`${options.label} instruction ${instruction} is unsupported`);
    }
  }
}

function decodeDockerfile(bytes: Buffer, label: string): string {
  const dockerfile = bytes.toString("utf8");
  if (!Buffer.from(dockerfile, "utf8").equals(bytes)) {
    throw new Error(`${label} must contain strict UTF-8`);
  }
  return dockerfile;
}

function stagedCuaPayloadSources(manifest: CuaRuntimeManifest): ReadonlySet<string> {
  return new Set(
    [
      manifest.agent.manifest,
      manifest.agent.dockerfile,
      manifest.agent.baseDockerfile,
      manifest.agent.policy,
      manifest.artifacts.hostCli,
      manifest.artifacts.targetServices,
      manifest.artifacts.adapters.target,
      manifest.artifacts.adapters.task,
      manifest.artifacts.adapters.security,
    ].map((identity) => path.posix.join("agents", "nemocua", identity.filename)),
  );
}

export function verifyCuaRuntimePayload(loaded: LoadedCuaRuntimeManifest): void {
  const { root, manifest } = loaded;
  for (const [label, identity] of [
    ["agent manifest", manifest.agent.manifest],
    ["agent Dockerfile", manifest.agent.dockerfile],
    ["agent base Dockerfile", manifest.agent.baseDockerfile],
    ["agent policy", manifest.agent.policy],
    ["host CLI", manifest.artifacts.hostCli],
    ["target services", manifest.artifacts.targetServices],
    ["target adapter", manifest.artifacts.adapters.target],
    ["task adapter", manifest.artifacts.adapters.task],
    ["security adapter", manifest.artifacts.adapters.security],
  ] as const) {
    verifyPayloadFile(root, identity, label, loaded.assertFileOwnership);
  }
  const baseDockerfile = decodeDockerfile(
    readBoundedRegularFile(path.join(root, manifest.agent.baseDockerfile.filename), {
      label: "agent base Dockerfile",
      minBytes: 2,
      maxBytes: 1024 * 1024,
    }),
    "NemoCUA base Dockerfile",
  );
  assertSingleBoundDockerfileBase(baseDockerfile, {
    argument: "NEMOCUA_RUNTIME_IMAGE",
    expectedArgument: /^ARG NEMOCUA_RUNTIME_IMAGE$/gm,
    expectedFrom:
      /^FROM \$\{NEMOCUA_RUNTIME_IMAGE\}(?:[ \t]+AS[ \t]+[A-Za-z0-9][A-Za-z0-9._-]{0,127})?[ \t]*$/gm,
    error: "NemoCUA base Dockerfile must use NEMOCUA_RUNTIME_IMAGE as its sole FROM base",
  });
  assertClosedDockerfileBuildInputs(baseDockerfile, {
    label: "NemoCUA base Dockerfile",
    allowedCopySources: new Set(),
  });
  const dockerfile = decodeDockerfile(
    readBoundedRegularFile(path.join(root, manifest.agent.dockerfile.filename), {
      label: "agent Dockerfile",
      minBytes: 2,
      maxBytes: 1024 * 1024,
    }),
    "NemoCUA Dockerfile",
  );
  assertSingleBoundDockerfileBase(dockerfile, {
    argument: "BASE_IMAGE",
    expectedArgument: /^ARG BASE_IMAGE(?:=.*)?$/gm,
    expectedFrom:
      /^FROM \$\{BASE_IMAGE\}(?:[ \t]+AS[ \t]+[A-Za-z0-9][A-Za-z0-9._-]{0,127})?[ \t]*$/gm,
    error: "NemoCUA Dockerfile must use its resolved BASE_IMAGE as its sole FROM base",
  });
  assertClosedDockerfileBuildInputs(dockerfile, {
    label: "NemoCUA Dockerfile",
    allowedCopySources: stagedCuaPayloadSources(manifest),
  });
}

export function getCuaExternalAgentManifestPath(
  env: NodeJS.ProcessEnv = process.env,
  options: CuaRuntimeManifestValidationOptions = {},
): string {
  const loaded = loadCuaRuntimeManifest(env, options);
  const manifestPath = verifyPayloadFile(
    loaded.root,
    loaded.manifest.agent.manifest,
    "agent manifest",
    loaded.assertFileOwnership,
  );
  validateExternalCuaAgentManifest(
    readBoundedRegularFile(manifestPath, {
      label: "external NemoCUA agent manifest",
      minBytes: 2,
      maxBytes: 256 * 1024,
    }),
  );
  return manifestPath;
}

export function getCuaSandboxImageRef(
  env: NodeJS.ProcessEnv = process.env,
  options: CuaRuntimeManifestValidationOptions = {},
): string {
  const loaded = loadCuaRuntimeManifest(env, options);
  const imageRef = env[CUA_SANDBOX_IMAGE_ENV]?.trim() ?? "";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/:+-]*@sha256:[0-9a-f]{64}$/.test(imageRef) ||
    !imageRef.endsWith(`@${loaded.manifest.artifacts.sandboxImage.digest}`)
  ) {
    throw new Error(
      `${CUA_SANDBOX_IMAGE_ENV} must be an immutable reference matching the runtime manifest`,
    );
  }
  return imageRef;
}

/** Revalidate the small authority-bearing files without rereading large release archives. */
export function verifyCuaRuntimeAuthorityPayload(
  env: NodeJS.ProcessEnv = process.env,
  options: CuaRuntimeManifestValidationOptions = {},
): LoadedCuaRuntimeManifest {
  const loaded = loadCuaRuntimeManifest(env, options);
  for (const [label, identity] of [
    ["agent manifest", loaded.manifest.agent.manifest],
    ["agent Dockerfile", loaded.manifest.agent.dockerfile],
    ["agent base Dockerfile", loaded.manifest.agent.baseDockerfile],
    ["agent policy", loaded.manifest.agent.policy],
    ["target adapter", loaded.manifest.artifacts.adapters.target],
    ["task adapter", loaded.manifest.artifacts.adapters.task],
    ["security adapter", loaded.manifest.artifacts.adapters.security],
  ] as const) {
    verifyPayloadFile(loaded.root, identity, label, loaded.assertFileOwnership);
  }
  getCuaExternalAgentManifestPath(env, options);
  return loaded;
}

/** Copy only manifest-declared, verified files into the temporary Docker context. */
export function stageCuaRuntimePayload(
  destination: string,
  env: NodeJS.ProcessEnv = process.env,
  options: CuaRuntimeManifestValidationOptions = {},
): void {
  const loaded = loadCuaRuntimeManifest(env, options);
  verifyCuaRuntimePayload(loaded);
  fs.mkdirSync(destination, { recursive: true });
  for (const identity of [
    loaded.manifest.agent.manifest,
    loaded.manifest.agent.dockerfile,
    loaded.manifest.agent.baseDockerfile,
    loaded.manifest.agent.policy,
    loaded.manifest.artifacts.hostCli,
    loaded.manifest.artifacts.targetServices,
    loaded.manifest.artifacts.adapters.target,
    loaded.manifest.artifacts.adapters.task,
    loaded.manifest.artifacts.adapters.security,
  ]) {
    copyVerifiedPayloadFile(
      loaded.root,
      identity,
      path.join(destination, identity.filename),
      identity.filename,
      loaded.assertFileOwnership,
    );
  }
}
