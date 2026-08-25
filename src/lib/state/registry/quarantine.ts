// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  SandboxQuarantineAttempt,
  SandboxQuarantineFence,
  SandboxQuarantineOperation,
  SandboxQuarantinePhase,
  SandboxQuarantineTarget,
} from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f-\u009f]+$/u;
const PHASES = new Set<SandboxQuarantinePhase>([
  "fenced",
  "stopping",
  "verifying",
  "quarantined",
  "partial",
]);
const OPERATIONS = new Set<SandboxQuarantineOperation>([
  "fence-persistence",
  "receipt-persistence",
  "messaging-stop",
  "dashboard-stop",
  "service-access-stop",
  "workload-stop",
  "execution-observation",
  "sandbox-access-observation",
]);
const OUTCOMES = new Set(["succeeded", "failed", "inconclusive"]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidQuarantine(): never {
  throw new Error(
    "Sandbox registry contains a malformed quarantine fence; repair the registry before changing sandbox lifecycle state",
  );
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function boundedSafeText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    SAFE_TEXT_PATTERN.test(value)
  );
}

function normalizeTarget(value: unknown): SandboxQuarantineTarget {
  if (!isObjectRecord(value) || !isObjectRecord(value.runtime)) invalidQuarantine();
  const gatewayPort = value.gatewayPort;
  if (
    !boundedSafeText(value.sandboxName, 128) ||
    typeof value.providerId !== "string" ||
    !PROVIDER_ID_PATTERN.test(value.providerId) ||
    !boundedSafeText(value.gatewayName, 128) ||
    typeof gatewayPort !== "number" ||
    !Number.isInteger(gatewayPort) ||
    gatewayPort < 1 ||
    gatewayPort > 65_535 ||
    !boundedSafeText(value.lifecycleGeneration, 512) ||
    typeof value.liveIdentityFingerprint !== "string" ||
    !SHA256_PATTERN.test(value.liveIdentityFingerprint) ||
    typeof value.providerHandle !== "string" ||
    !SHA256_PATTERN.test(value.providerHandle) ||
    !boundedSafeText(value.providerLifecycleGeneration, 512) ||
    !boundedSafeText(value.runtime.kind, 128) ||
    !boundedSafeText(value.runtime.handle, 4_096)
  ) {
    invalidQuarantine();
  }
  return {
    sandboxName: value.sandboxName,
    providerId: value.providerId,
    gatewayName: value.gatewayName,
    gatewayPort,
    lifecycleGeneration: value.lifecycleGeneration,
    liveIdentityFingerprint: value.liveIdentityFingerprint,
    providerHandle: value.providerHandle,
    providerLifecycleGeneration: value.providerLifecycleGeneration,
    runtime: { kind: value.runtime.kind, handle: value.runtime.handle },
  };
}

function normalizeAttempt(value: unknown): SandboxQuarantineAttempt {
  if (
    !isObjectRecord(value) ||
    typeof value.operation !== "string" ||
    !OPERATIONS.has(value.operation as SandboxQuarantineOperation) ||
    !isCanonicalIsoTimestamp(value.attemptedAt) ||
    typeof value.outcome !== "string" ||
    !OUTCOMES.has(value.outcome) ||
    (value.detail !== undefined && !boundedSafeText(value.detail, 512))
  ) {
    invalidQuarantine();
  }
  return {
    operation: value.operation as SandboxQuarantineOperation,
    attemptedAt: value.attemptedAt,
    outcome: value.outcome as SandboxQuarantineAttempt["outcome"],
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
  };
}

/** Normalize a persisted restart fence and reject incomplete authority. */
export function normalizeSandboxQuarantineFence(
  value: unknown,
): SandboxQuarantineFence | undefined {
  if (value === undefined) return undefined;
  if (
    !isObjectRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.fenceId !== "string" ||
    !UUID_PATTERN.test(value.fenceId) ||
    typeof value.requestIdentity !== "string" ||
    !SHA256_PATTERN.test(value.requestIdentity) ||
    typeof value.reasonDigest !== "string" ||
    !SHA256_PATTERN.test(value.reasonDigest) ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    !isCanonicalIsoTimestamp(value.updatedAt) ||
    typeof value.phase !== "string" ||
    !PHASES.has(value.phase as SandboxQuarantinePhase) ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > 32
  ) {
    invalidQuarantine();
  }
  const createdAt = new Date(value.createdAt).getTime();
  const updatedAt = new Date(value.updatedAt).getTime();
  if (updatedAt < createdAt) invalidQuarantine();
  return {
    schemaVersion: 1,
    fenceId: value.fenceId,
    requestIdentity: value.requestIdentity,
    reasonDigest: value.reasonDigest,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    phase: value.phase as SandboxQuarantinePhase,
    target: normalizeTarget(value.target),
    attempts: value.attempts.map(normalizeAttempt),
  };
}
