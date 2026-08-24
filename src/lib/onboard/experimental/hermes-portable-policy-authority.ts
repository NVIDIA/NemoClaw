// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import YAML from "yaml";

import { parseOpenShellPolicy } from "../../policy/merge";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const MAX_POLICY_BYTES = 256 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const PROC_PATH = "/proc";
const OPENSHELL_PROXY_REQUIRED_READ_ONLY_PATHS = new Set([
  "/usr",
  "/lib",
  "/etc",
  "/app",
  "/var/log",
  "/dev/urandom",
]);
const OPENSHELL_PROXY_REQUIRED_READ_WRITE_PATHS = new Set(["/tmp"]);
const OPENSHELL_GPU_READ_ONLY_PATHS = new Set(["/run/nvidia-persistenced", "/usr/lib/wsl"]);
const OPENSHELL_GPU_READ_WRITE_PATHS = new Set([
  "/dev/nvidiactl",
  "/dev/nvidia-uvm",
  "/dev/nvidia-uvm-tools",
  "/dev/nvidia-modeset",
  "/dev/dxg",
  PROC_PATH,
]);
const OPENSHELL_GPU_DEVICE_PATH = /^\/dev\/nvidia[0-9]+$/u;

export interface HermesPortablePolicyCaptureResult {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly error?: Error;
}

export interface HermesPortablePolicyCapture {
  (args: readonly string[]): HermesPortablePolicyCaptureResult;
}

export interface HermesPortableLivePolicyProof {
  readonly intendedSemanticSha256: string;
  readonly verifiedLivePolicySemanticSha256: string;
}

function fail(message: string): never {
  throw new Error(`Hermes portable policy authority ${message}`);
}

function decode(bytes: Buffer, label: string): string {
  if (bytes.length > MAX_POLICY_BYTES) fail(`${label} exceeds the byte limit`);
  try {
    return UTF8.decode(bytes);
  } catch {
    fail(`${label} is not strict UTF-8`);
  }
}

interface CanonicalState {
  readonly active: WeakSet<object>;
  nodes: number;
}

function canonical(
  value: unknown,
  state: CanonicalState = { active: new WeakSet(), nodes: 0 },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (state.nodes > 16_384 || depth > 64) fail("contains an oversized semantic structure");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") fail("contains a non-JSON semantic value");
  if (state.active.has(value)) fail("contains a cyclic semantic structure");
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonical(entry, state, depth + 1));
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key.length === 0 || key.length > 1024) fail("contains an invalid mapping key");
      result[key] = canonical((value as Record<string, unknown>)[key], state, depth + 1);
    }
    return result;
  } finally {
    state.active.delete(value);
  }
}

function parseOnePolicyDocument(raw: string, label: string): Record<string, unknown> {
  let parsed: ReturnType<typeof parseOpenShellPolicy>;
  try {
    parsed = parseOpenShellPolicy(raw);
  } catch {
    fail(`${label} is invalid`);
  }
  const separators = [...raw.matchAll(/(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/gu)];
  if (separators.length > 1) fail(`${label} is duplicate or ambiguous`);
  if (separators.length === 1 && separators[0]!.index! > 0) {
    const prefix = raw.slice(0, separators[0]!.index).trim();
    if (prefix) {
      const prefixDocuments = YAML.parseAllDocuments(prefix);
      const prefixPolicy = prefixDocuments[0]?.toJSON();
      if (
        prefixDocuments.length !== 1 ||
        prefixDocuments[0]!.errors.length > 0 ||
        (prefixPolicy &&
          typeof prefixPolicy === "object" &&
          !Array.isArray(prefixPolicy) &&
          ("version" in prefixPolicy || "network_policies" in prefixPolicy))
      ) {
        fail(`${label} is duplicate or ambiguous`);
      }
    }
  }
  const documents = YAML.parseAllDocuments(parsed.yamlBody);
  if (documents.length !== 1 || documents[0]!.errors.length > 0) {
    fail(`${label} is duplicate or ambiguous`);
  }
  return parsed.policy;
}

function semanticDigest(policy: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(policy)))
    .digest("hex");
}

function policyWithoutFilesystemPolicy(policy: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(policy)) {
    if (key !== "filesystem_policy") result[key] = policy[key];
  }
  return result;
}

function filesystemPolicyWithoutPaths(policy: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(policy)) {
    if (key !== "read_only" && key !== "read_write") result[key] = policy[key];
  }
  return result;
}

function readUniquePaths(
  policy: Record<string, unknown>,
  key: "read_only" | "read_write",
): Set<string> | null {
  const value = policy[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  const paths = new Set(value);
  return paths.size === value.length ? paths : null;
}

function isSubset(subset: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  return [...subset].every((entry) => superset.has(entry));
}

function setsOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].some((entry) => right.has(entry));
}

function isOpenShellNativeGpuBaselineEnrichment(
  intended: Record<string, unknown>,
  live: Record<string, unknown>,
): boolean {
  if (
    semanticDigest(policyWithoutFilesystemPolicy(intended)) !==
    semanticDigest(policyWithoutFilesystemPolicy(live))
  ) {
    return false;
  }
  const intendedFilesystem = intended.filesystem_policy;
  const liveFilesystem = live.filesystem_policy;
  if (
    !intendedFilesystem ||
    typeof intendedFilesystem !== "object" ||
    Array.isArray(intendedFilesystem) ||
    !liveFilesystem ||
    typeof liveFilesystem !== "object" ||
    Array.isArray(liveFilesystem)
  ) {
    return false;
  }
  const intendedFilesystemRecord = intendedFilesystem as Record<string, unknown>;
  const liveFilesystemRecord = liveFilesystem as Record<string, unknown>;
  if (
    semanticDigest(filesystemPolicyWithoutPaths(intendedFilesystemRecord)) !==
    semanticDigest(filesystemPolicyWithoutPaths(liveFilesystemRecord))
  ) {
    return false;
  }
  const intendedReadOnly = readUniquePaths(intendedFilesystemRecord, "read_only");
  const intendedReadWrite = readUniquePaths(intendedFilesystemRecord, "read_write");
  const liveReadOnly = readUniquePaths(liveFilesystemRecord, "read_only");
  const liveReadWrite = readUniquePaths(liveFilesystemRecord, "read_write");
  if (!intendedReadOnly || !intendedReadWrite || !liveReadOnly || !liveReadWrite) return false;
  if (
    setsOverlap(intendedReadOnly, intendedReadWrite) ||
    setsOverlap(liveReadOnly, liveReadWrite)
  ) {
    return false;
  }

  // The native direct-GPU create policy deliberately omits /proc so OpenShell
  // can add it read-write only after it observes the GPU devices. Treat that
  // exact omission as the authority signal; ordinary/non-GPU policies retain
  // /proc read-only and cannot use this exception.
  if (intendedReadOnly.has(PROC_PATH) || intendedReadWrite.has(PROC_PATH)) return false;
  if (
    !isSubset(OPENSHELL_PROXY_REQUIRED_READ_ONLY_PATHS, intendedReadOnly) ||
    !isSubset(OPENSHELL_PROXY_REQUIRED_READ_WRITE_PATHS, intendedReadWrite)
  ) {
    return false;
  }
  if (liveReadOnly.has(PROC_PATH) || !liveReadWrite.has(PROC_PATH)) return false;
  if (!isSubset(intendedReadOnly, liveReadOnly) || !isSubset(intendedReadWrite, liveReadWrite)) {
    return false;
  }

  for (const path of liveReadOnly) {
    if (!intendedReadOnly.has(path) && !OPENSHELL_GPU_READ_ONLY_PATHS.has(path)) return false;
  }
  for (const path of liveReadWrite) {
    if (
      !intendedReadWrite.has(path) &&
      !OPENSHELL_GPU_READ_WRITE_PATHS.has(path) &&
      !OPENSHELL_GPU_DEVICE_PATH.test(path)
    ) {
      return false;
    }
  }
  return true;
}

function rejectReservedCreateEntries(policy: Record<string, unknown>): void {
  const policies = policy.network_policies;
  if (!policies || typeof policies !== "object" || Array.isArray(policies)) return;
  if (Object.keys(policies).some((name) => name.startsWith("_provider_"))) {
    fail("create input contains a reserved provider-composed entry");
  }
}

function parseCreatePolicy(bytes: Buffer): Record<string, unknown> {
  const policy = parseOnePolicyDocument(decode(bytes, "create input"), "create input");
  rejectReservedCreateEntries(policy);
  return policy;
}

/** Capture and bind the exact create-policy bytes before sandbox creation. */
export function hermesPortableCreatePolicySemanticDigest(bytes: Buffer): string {
  return semanticDigest(parseCreatePolicy(bytes));
}

function capturePolicy(
  capture: HermesPortablePolicyCapture,
  args: readonly string[],
  label: string,
): Record<string, unknown> {
  const result = capture(args);
  decode(result.stderr, `${label} stderr`);
  if (result.status !== 0 || result.error) {
    fail(`${label} failed with status ${String(result.status)}`);
  }
  return parseOnePolicyDocument(decode(result.stdout, label), label);
}

/**
 * Prove the current 0.0.106 Hermes matrix's empty provider projection.
 * Both reads are explicitly gateway and sandbox scoped. A non-empty full/base
 * delta is unsupported until OpenShell exposes an authoritative projection.
 */
export function proveHermesPortableLivePolicy(input: {
  readonly gatewayName: string;
  readonly sandboxName: string;
  readonly createPolicyBytes: Buffer;
  readonly capture: HermesPortablePolicyCapture;
}): HermesPortableLivePolicyProof {
  if (!NAME.test(input.gatewayName) || !NAME.test(input.sandboxName)) {
    fail("gateway or sandbox identity is invalid");
  }
  const intended = parseCreatePolicy(input.createPolicyBytes);
  const intendedSemanticSha256 = semanticDigest(intended);
  const prefix = ["policy", "get", "-g", input.gatewayName] as const;
  const base = capturePolicy(
    input.capture,
    [...prefix, "--base", input.sandboxName],
    "scoped base policy",
  );
  const full = capturePolicy(
    input.capture,
    [...prefix, "--full", input.sandboxName],
    "scoped full policy",
  );
  const baseDigest = semanticDigest(base);
  const fullDigest = semanticDigest(full);
  if (
    baseDigest !== intendedSemanticSha256 &&
    !isOpenShellNativeGpuBaselineEnrichment(intended, base)
  ) {
    fail("scoped base policy disagrees with create input");
  }
  if (fullDigest !== baseDigest) {
    fail("scoped full policy contains an unproven provider-composed or out-of-band delta");
  }
  return {
    intendedSemanticSha256,
    verifiedLivePolicySemanticSha256: fullDigest,
  };
}

export const hermesPortablePolicyAuthorityInternals = {
  isOpenShellNativeGpuBaselineEnrichment,
  semanticDigest,
};
