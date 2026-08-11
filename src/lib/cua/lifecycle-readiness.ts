// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import { resolveLiveInferenceGatewayName } from "../inference/gateway-route-compatibility";
import { captureResolvedOpenshell, parseGatewayInference, stripAnsi } from "../inference/live";
import { parseGatewayProviderMetadata } from "../onboard/gateway-provider-metadata";
import type { SandboxEntry } from "../state/registry/types";
import { type CuaAppliedPolicyIdentity, type CuaRuntimeReadiness } from "./contract";
import { isCuaQualificationEnabled } from "./feature";
import { getStoredCuaOpenshellDigest, snapshotCuaOpenshellExecutable } from "./openshell-authority";
import { validateCurrentCuaRuntimeReadiness } from "./runtime-readiness";

const MAX_INFERENCE_STATUS_BYTES = 64 * 1024;
const INFERENCE_STATUS_TIMEOUT_MS = 10_000;
const MAX_POLICY_STATUS_BYTES = 64 * 1024;
const POLICY_STATUS_TIMEOUT_MS = 10_000;
const PROVIDER_IDENTITY = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const POLICY_STATUS_FIELDS = new Set([
  "active_version",
  "config_revision",
  "hash",
  "policy_source",
  "sandbox",
  "status",
  "version",
]);
const PROVIDER_FIELDS = new Set([
  "provider",
  "id",
  "name",
  "type",
  "resource version",
  "credential keys",
  "config keys",
]);

export interface CuaLiveInferenceObservation {
  provider: string;
  model: string;
  providerAuthorityDigest: string;
  /** Digest of the private OpenShell snapshot used for this observation. */
  openshellDigest?: string;
}

interface CuaOpenshellObservationOptions {
  openshellBinary?: string;
  expectedDigest?: string;
  env?: NodeJS.ProcessEnv;
}

function policyStatusRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the live applied CUA policy identity is unavailable");
  }
  return value as Record<string, unknown>;
}

/** Parse bounded OpenShell policy status into a content-free applied-policy identity. */
export function parseCuaAppliedPolicyIdentity(input: {
  sandboxName: string;
  output: string;
}): CuaAppliedPolicyIdentity {
  const { sandboxName, output } = input;
  if (
    Buffer.byteLength(output, "utf8") > MAX_POLICY_STATUS_BYTES ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(output)
  ) {
    throw new Error("the live applied CUA policy identity is unavailable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("the live applied CUA policy identity is unavailable");
  }
  const record = policyStatusRecord(parsed);
  const keys = Object.keys(record);
  if (
    keys.some((key) => !POLICY_STATUS_FIELDS.has(key)) ||
    !["active_version", "hash", "sandbox", "status", "version"].every((key) =>
      Object.hasOwn(record, key),
    )
  ) {
    throw new Error("the live applied CUA policy identity is unavailable");
  }
  const revision = record.version;
  if (
    !Number.isSafeInteger(revision) ||
    Number(revision) < 0 ||
    record.active_version !== revision ||
    record.status !== "effective" ||
    record.sandbox !== sandboxName ||
    typeof record.hash !== "string" ||
    !SHA256_DIGEST.test(record.hash) ||
    (record.policy_source !== undefined && record.policy_source !== "sandbox")
  ) {
    throw new Error("the live applied CUA policy identity is unavailable");
  }
  if (record.config_revision !== undefined) {
    const revisions = [...output.matchAll(/"config_revision"\s*:\s*(0|[1-9][0-9]*)(?=\s*[,}])/gu)];
    if (revisions.length !== 1) {
      throw new Error("the live applied CUA policy identity is unavailable");
    }
  }
  return { revision: Number(revision), digest: record.hash };
}

/** Parse one bounded, content-free provider observation into an opaque host authority digest. */
export function parseCuaProviderAuthorityDigest(input: {
  gatewayName: string;
  providerName: string;
  model: string;
  output: string;
}): string {
  const { gatewayName, providerName, model, output } = input;
  if (
    Buffer.byteLength(output, "utf8") > MAX_INFERENCE_STATUS_BYTES ||
    !PROVIDER_IDENTITY.test(gatewayName) ||
    !PROVIDER_IDENTITY.test(providerName) ||
    model.length < 1 ||
    model.length > 512 ||
    /[\x00-\x1f\x7f]/u.test(model)
  ) {
    throw new Error("the live managed inference provider identity is unavailable");
  }
  for (const rawLine of output.split(/\r?\n/u)) {
    const cleanLine = stripAnsi(rawLine).trim();
    const separator = cleanLine.indexOf(":");
    if (separator < 0) continue;
    const field = cleanLine.slice(0, separator).trim().toLowerCase();
    if (!PROVIDER_FIELDS.has(field)) {
      throw new Error("the live managed inference provider identity is unavailable");
    }
    const rawSeparator = rawLine.indexOf(":");
    const rawValue = rawLine
      .slice(rawSeparator + 1)
      .replace(/^(?:\x1B\[[0-?]*[ -/]*[@-~])*[ \t]*/u, "");
    if (/[\x00-\x1f\x7f-\x9f]/u.test(rawValue)) {
      throw new Error("the live managed inference provider identity is unavailable");
    }
  }
  const metadata = parseGatewayProviderMetadata(output);
  const clean = stripAnsi(output);
  const ids = Array.from(clean.matchAll(/^\s*Id:\s*([^\s]+)\s*$/gimu));
  const versions = Array.from(clean.matchAll(/^\s*Resource version:\s*([0-9]+)\s*$/gimu));
  const id = ids[0]?.[1] ?? "";
  const resourceVersion = Number(versions[0]?.[1] ?? "");
  if (
    !metadata ||
    metadata.name !== providerName ||
    ids.length !== 1 ||
    versions.length !== 1 ||
    !PROVIDER_IDENTITY.test(id) ||
    !Number.isSafeInteger(resourceVersion) ||
    resourceVersion < 1
  ) {
    throw new Error("the live managed inference provider identity is unavailable");
  }
  return `sha256:${crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        gatewayName,
        provider: providerName,
        model,
        id,
        resourceVersion,
        name: metadata.name,
        type: metadata.type,
        credentialKeys: [...metadata.credentialKeys].sort(),
        configKeys: [...metadata.configKeys].sort(),
      }),
    )
    .digest("hex")}`;
}

export interface CuaLifecycleReadinessDeps {
  env?: NodeJS.ProcessEnv;
  observeLiveInference?: (entry: SandboxEntry) => CuaLiveInferenceObservation;
  observeLiveAppliedPolicy?: (entry: SandboxEntry) => CuaAppliedPolicyIdentity;
  validateRuntimeReadiness?: typeof validateCurrentCuaRuntimeReadiness;
}

/** Re-observe the exact effective OpenShell policy without exposing policy content. */
export function observeCuaLiveAppliedPolicy(
  entry: SandboxEntry,
  options: CuaOpenshellObservationOptions = {},
): CuaAppliedPolicyIdentity {
  const snapshot = snapshotCuaOpenshellExecutable({
    selectedBinary: options.openshellBinary,
    expectedDigest:
      options.expectedDigest ?? getStoredCuaOpenshellDigest(entry.cuaRuntimeReadiness),
    env: options.env,
  });
  try {
    const observed = captureResolvedOpenshell(["policy", "get", entry.name, "--output", "json"], {
      openshellBinary: snapshot.executable,
      ignoreError: true,
      timeout: POLICY_STATUS_TIMEOUT_MS,
      maxBuffer: MAX_POLICY_STATUS_BYTES,
    });
    if (observed.status !== 0) {
      throw new Error("the live applied CUA policy identity is unavailable");
    }
    return parseCuaAppliedPolicyIdentity({ sandboxName: entry.name, output: observed.output });
  } finally {
    snapshot.cleanup();
  }
}

/** Require one content-free observation of the effective policy for lifecycle admission. */
export function requireCuaLiveAppliedPolicy(
  entry: SandboxEntry,
  deps: CuaLifecycleReadinessDeps = {},
): CuaAppliedPolicyIdentity {
  return deps.observeLiveAppliedPolicy
    ? deps.observeLiveAppliedPolicy(entry)
    : observeCuaLiveAppliedPolicy(entry, { env: deps.env });
}

/** Re-observe the exact gateway route before granting lifecycle authority. */
export function observeCuaLiveInference(
  entry: SandboxEntry,
  options: CuaOpenshellObservationOptions = {},
): CuaLiveInferenceObservation {
  const snapshot = snapshotCuaOpenshellExecutable({
    selectedBinary: options.openshellBinary,
    expectedDigest:
      options.expectedDigest ?? getStoredCuaOpenshellDigest(entry.cuaRuntimeReadiness),
    env: options.env,
  });
  try {
    const gatewayName = resolveLiveInferenceGatewayName(entry);
    const capture = (args: string[]) =>
      captureResolvedOpenshell(args, {
        openshellBinary: snapshot.executable,
        ignoreError: true,
        timeout: INFERENCE_STATUS_TIMEOUT_MS,
        maxBuffer: MAX_INFERENCE_STATUS_BYTES,
      });
    const inferenceBefore = capture(["inference", "get", "-g", gatewayName]);
    const live =
      inferenceBefore.status === 0 ? parseGatewayInference(inferenceBefore.output) : null;
    if (!live?.provider || !live.model) {
      throw new Error("the live managed inference route is unavailable");
    }
    const providerBefore = capture(["provider", "get", "-g", gatewayName, live.provider]);
    const inferenceAfter = capture(["inference", "get", "-g", gatewayName]);
    const providerAfter = capture(["provider", "get", "-g", gatewayName, live.provider]);
    const after = inferenceAfter.status === 0 ? parseGatewayInference(inferenceAfter.output) : null;
    if (
      providerBefore.status !== 0 ||
      providerAfter.status !== 0 ||
      after?.provider !== live.provider ||
      after?.model !== live.model
    ) {
      throw new Error("the live managed inference provider identity is unavailable");
    }
    const beforeDigest = parseCuaProviderAuthorityDigest({
      gatewayName,
      providerName: live.provider,
      model: live.model,
      output: providerBefore.output,
    });
    const afterDigest = parseCuaProviderAuthorityDigest({
      gatewayName,
      providerName: live.provider,
      model: live.model,
      output: providerAfter.output,
    });
    if (beforeDigest !== afterDigest) {
      throw new Error("the live managed inference provider identity changed during validation");
    }
    return {
      provider: live.provider,
      model: live.model,
      providerAuthorityDigest: beforeDigest,
      openshellDigest: snapshot.executableDigest,
    };
  } finally {
    snapshot.cleanup();
  }
}

/**
 * Validate stored readiness against the executing build, external manifest,
 * immutable qualification evidence, durable route, and live gateway route.
 */
export function requireCuaLifecycleReadiness(
  entry: SandboxEntry,
  deps: CuaLifecycleReadinessDeps = {},
): CuaRuntimeReadiness {
  if (!entry.cuaRuntimeReadiness) throw new Error("CUA runtime readiness is unavailable");
  const env = deps.env ?? process.env;
  if (!isCuaQualificationEnabled(env)) {
    throw new Error("CUA candidate readiness requires exact qualification authority");
  }
  const live = deps.observeLiveInference
    ? deps.observeLiveInference(entry)
    : observeCuaLiveInference(entry, { env });
  const appliedPolicy = requireCuaLiveAppliedPolicy(entry, deps);
  return (deps.validateRuntimeReadiness ?? validateCurrentCuaRuntimeReadiness)(
    entry.cuaRuntimeReadiness,
    {
      agentName: entry.agent,
      recordedInference: entry,
      liveInference: { ...entry, provider: live.provider, model: live.model },
      liveProviderAuthorityDigest: live.providerAuthorityDigest,
      liveAppliedPolicy: appliedPolicy,
      ...(live.openshellDigest ? { expectedOpenshellDigest: live.openshellDigest } : {}),
      acceptance: "candidate-qualification",
      env,
    },
  );
}
