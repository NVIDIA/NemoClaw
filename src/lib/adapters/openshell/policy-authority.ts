// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import {
  diagnosticPreview,
  isValidName,
  NAME_ALLOWED_FORMAT,
  NAME_MAX_LENGTH,
} from "../../sandbox-name-contract";
import { buildPolicyGetFullJsonCommand } from "../../policy/commands";
const POLICY_AUTHORITY_CAPTURE_MAX_BYTES = 1024 * 1024;
const POLICY_AUTHORITY_CAPTURE_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

export type SandboxPolicyAuthority = "nemoclaw-managed" | "externally-managed";

export interface SandboxPolicyAuthorityInspection {
  readonly authority: SandboxPolicyAuthority;
  readonly effectivePolicy: JsonObject;
}

const POLICY_AUTHORITY_REFUSAL_CODE = "NEMOCLAW_POLICY_AUTHORITY_REFUSAL";

/** A final refusal at the OpenShell policy authority boundary. */
export class PolicyAuthorityRefusalError extends Error {
  readonly code = POLICY_AUTHORITY_REFUSAL_CODE;

  constructor(message: string) {
    super(message);
    this.name = "PolicyAuthorityRefusalError";
  }
}

/** Recognize policy-authority refusals across CommonJS and ESM module boundaries. */
export function isPolicyAuthorityRefusalError(error: unknown): boolean {
  return (
    error instanceof PolicyAuthorityRefusalError ||
    (isObject(error) && error.code === POLICY_AUTHORITY_REFUSAL_CODE)
  );
}

interface PolicyAuthorityCaptureResult {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export type PolicyAuthorityCapture = (
  command: readonly string[],
  options?: { readonly maxBuffer?: number; readonly timeout?: number },
) => PolicyAuthorityCaptureResult;

interface SandboxPolicyAuthorityInspectionOptions {
  readonly sandboxName: string;
  readonly gatewayName?: string;
  readonly runCaptureEx: PolicyAuthorityCapture;
}

function validatePolicyAuthorityName(name: string, label: string): string {
  if (!name || typeof name !== "string") {
    throw new PolicyAuthorityRefusalError(
      `${label} is required. Allowed format: ${NAME_ALLOWED_FORMAT}.`,
    );
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw new PolicyAuthorityRefusalError(
      `${label} too long (max ${NAME_MAX_LENGTH} chars): ${diagnosticPreview(name)}. Allowed format: ${NAME_ALLOWED_FORMAT}.`,
    );
  }
  if (isValidName(name)) return name;
  throw new PolicyAuthorityRefusalError(
    `Invalid ${label}: ${diagnosticPreview(name)}. Allowed format: ${NAME_ALLOWED_FORMAT}.`,
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPolicyAuthority(value: unknown): value is SandboxPolicyAuthority {
  return value === "nemoclaw-managed" || value === "externally-managed";
}

function failInspection(subject: "sandbox" | "global", reason: string): never {
  throw new PolicyAuthorityRefusalError(
    `OpenShell ${subject} policy authority inspection failed: ${reason}. Policy-dependent operations must stop.`,
  );
}

function capturePolicyQuery(
  command: readonly string[],
  capture: PolicyAuthorityCapture,
  subject: "sandbox" | "global",
  queryKind: "machine-readable policy" | "policy history",
): { readonly stdout: string; readonly stderr: string } {
  let result: PolicyAuthorityCaptureResult;
  try {
    result = capture(command, {
      maxBuffer: POLICY_AUTHORITY_CAPTURE_MAX_BYTES,
      timeout: POLICY_AUTHORITY_CAPTURE_TIMEOUT_MS,
    });
  } catch {
    failInspection(subject, `the ${queryKind} query could not run`);
  }

  if (
    !isObject(result) ||
    typeof result.stdout !== "string" ||
    (result.stderr !== undefined && typeof result.stderr !== "string")
  ) {
    failInspection(subject, `the ${queryKind} query returned an invalid capture result`);
  }
  const stderr = result.stderr ?? "";
  if (
    Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(stderr, "utf8") >
    POLICY_AUTHORITY_CAPTURE_MAX_BYTES
  ) {
    failInspection(subject, `the ${queryKind} response exceeded the capture limit`);
  }
  if (result.timedOut === true) {
    failInspection(subject, `the ${queryKind} query timed out`);
  }
  if (result.timedOut !== false || result.exitCode !== 0) {
    failInspection(subject, `the ${queryKind} query did not complete successfully`);
  }
  return { stdout: result.stdout, stderr };
}

function parsePolicyMetadata(raw: string, subject: "sandbox" | "global"): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    failInspection(subject, "OpenShell returned malformed machine-readable policy metadata");
  }
  if (!isObject(parsed)) {
    failInspection(subject, "OpenShell returned an invalid policy metadata object");
  }
  return parsed;
}

function policyObject(metadata: JsonObject, subject: "sandbox" | "global"): JsonObject {
  if (!isObject(metadata.policy)) {
    failInspection(subject, "OpenShell did not return an effective policy object");
  }
  return metadata.policy;
}

/** Inspect the effective policy source for one live sandbox. */
export function inspectSandboxPolicyAuthority({
  sandboxName,
  gatewayName,
  runCaptureEx,
}: SandboxPolicyAuthorityInspectionOptions): SandboxPolicyAuthorityInspection {
  const validatedSandboxName = validatePolicyAuthorityName(sandboxName, "sandbox name");
  const validatedGatewayName =
    gatewayName === undefined
      ? undefined
      : validatePolicyAuthorityName(gatewayName, "gateway name");
  const { stdout: raw } = capturePolicyQuery(
    buildPolicyGetFullJsonCommand(validatedSandboxName, validatedGatewayName),
    runCaptureEx,
    "sandbox",
    "machine-readable policy",
  );
  if (raw.trim().length === 0) {
    failInspection("sandbox", "OpenShell returned empty policy metadata");
  }
  const metadata = parsePolicyMetadata(raw, "sandbox");
  if (metadata.scope !== "sandbox") {
    failInspection("sandbox", "OpenShell returned policy metadata for another scope");
  }
  if (metadata.sandbox !== validatedSandboxName) {
    failInspection("sandbox", "OpenShell returned policy metadata for another sandbox");
  }
  if (metadata.status !== "effective") {
    failInspection("sandbox", "OpenShell did not report an effective sandbox policy");
  }
  if (metadata.policy_source !== "sandbox" && metadata.policy_source !== "global") {
    failInspection("sandbox", "OpenShell returned an unknown policy source");
  }
  return {
    authority: metadata.policy_source === "sandbox" ? "nemoclaw-managed" : "externally-managed",
    effectivePolicy: policyObject(metadata, "sandbox"),
  };
}

function operationLabel(operation: string): string {
  return typeof operation === "string" && operation.trim().length > 0
    ? operation.trim()
    : "continue the policy-dependent operation";
}

/** Refuse a lifecycle operation when its durable and observed authority disagree. */
export function assertRecordedPolicyAuthority(
  recorded: unknown,
  observed: unknown,
  operation: string,
): void {
  const label = operationLabel(operation);
  if (!isPolicyAuthority(recorded)) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${label}: the recorded policy authority is unavailable or invalid.`,
    );
  }
  if (!isPolicyAuthority(observed)) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${label}: the observed OpenShell policy authority is unavailable or invalid.`,
    );
  }
  if (recorded !== observed) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${label}: OpenShell policy authority changed from ${recorded} to ${observed}.`,
    );
  }
}

function networkPolicies(policy: JsonObject, label: string): JsonObject {
  const value = policy.network_policies;
  if (value === undefined) return {};
  if (!isObject(value)) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${label}: the required network policy input is invalid.`,
    );
  }
  return value;
}

function formatPolicyKeys(keys: readonly string[]): string {
  return keys.map((key) => JSON.stringify(key)).join(", ");
}

/**
 * Verify that an externally supplied policy contains each required entry and
 * section without claiming ownership. Unrelated external entries are allowed.
 */
export function assertExternalPolicyRequirements({
  inspection,
  requiredPolicy,
  operation,
  sandboxName,
}: {
  readonly inspection: SandboxPolicyAuthorityInspection;
  readonly requiredPolicy: JsonObject;
  readonly operation: string;
  readonly sandboxName?: string;
}): void {
  const label = operationLabel(operation);
  if (!isPolicyAuthority(inspection.authority)) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${label}: the observed OpenShell policy authority is invalid.`,
    );
  }
  if (inspection.authority === "nemoclaw-managed") return;
  if (!isObject(requiredPolicy) || !isObject(inspection.effectivePolicy)) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${label}: the policy requirement input is invalid.`,
    );
  }

  const required = networkPolicies(requiredPolicy, label);
  const observedValue = inspection.effectivePolicy.network_policies;
  const observed = isObject(observedValue) ? observedValue : null;
  const missing: string[] = [];
  const drifted: string[] = [];
  for (const key of Object.keys(required).sort()) {
    if (!observed || !Object.hasOwn(observed, key)) {
      missing.push(key);
    } else if (!isDeepStrictEqual(observed[key], required[key])) {
      drifted.push(key);
    }
  }
  const requiredSections = Object.keys(requiredPolicy)
    .filter((key) => key !== "network_policies" && key !== "version")
    .sort();
  const missingSections: string[] = [];
  const driftedSections: string[] = [];
  for (const key of requiredSections) {
    if (!Object.hasOwn(inspection.effectivePolicy, key)) {
      missingSections.push(key);
    } else if (!isDeepStrictEqual(inspection.effectivePolicy[key], requiredPolicy[key])) {
      driftedSections.push(key);
    }
  }
  if (
    missing.length === 0 &&
    drifted.length === 0 &&
    missingSections.length === 0 &&
    driftedSections.length === 0
  ) {
    return;
  }

  const target = sandboxName ? ` for sandbox ${JSON.stringify(sandboxName)}` : "";
  const differences = [
    ...(missing.length > 0 ? [`missing entries ${formatPolicyKeys(missing)}`] : []),
    ...(drifted.length > 0 ? [`drifted entries ${formatPolicyKeys(drifted)}`] : []),
    ...(missingSections.length > 0
      ? [`missing sections ${formatPolicyKeys(missingSections)}`]
      : []),
    ...(driftedSections.length > 0
      ? [`drifted sections ${formatPolicyKeys(driftedSections)}`]
      : []),
  ].join("; ");
  throw new PolicyAuthorityRefusalError(
    `Refusing to ${label}${target}: the externally managed policy has ${differences}. Ask the external policy authority to supply the exact required entries.`,
  );
}

export const policyAuthorityInternals = {
  captureMaxBytes: POLICY_AUTHORITY_CAPTURE_MAX_BYTES,
  captureTimeoutMs: POLICY_AUTHORITY_CAPTURE_TIMEOUT_MS,
};
