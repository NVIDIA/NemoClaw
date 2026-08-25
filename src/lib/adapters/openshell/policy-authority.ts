// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  diagnosticPreview,
  isValidName,
  NAME_ALLOWED_FORMAT,
  NAME_MAX_LENGTH,
} from "../../sandbox-name-contract";
import { buildPolicyGetFullJsonCommand } from "../../policy/commands";
import {
  assertExternalPolicyRequirementContainment,
  assertMatchingPolicyAuthority,
  type OpenShellPolicyAuthority,
  parseSandboxPolicyAuthorityMetadata,
  type SandboxPolicyAuthorityInspection as CanonicalSandboxPolicyAuthorityInspection,
} from "../../policy/merge";
const POLICY_AUTHORITY_CAPTURE_MAX_BYTES = 1024 * 1024;
const POLICY_AUTHORITY_CAPTURE_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

export type SandboxPolicyAuthority = OpenShellPolicyAuthority;
export type SandboxPolicyAuthorityInspection = CanonicalSandboxPolicyAuthorityInspection;

const POLICY_AUTHORITY_REFUSAL_CODE = "NEMOCLAW_POLICY_AUTHORITY_REFUSAL";

/** A final refusal at the OpenShell policy authority boundary. */
export class PolicyAuthorityRefusalError extends Error {
  readonly code = POLICY_AUTHORITY_REFUSAL_CODE;
  readonly observedAuthority?: SandboxPolicyAuthority;

  constructor(message: string, observedAuthority?: SandboxPolicyAuthority) {
    super(message);
    this.name = "PolicyAuthorityRefusalError";
    this.observedAuthority = observedAuthority;
  }
}

/** Recognize policy-authority refusals across CommonJS and ESM module boundaries. */
export function isPolicyAuthorityRefusalError(error: unknown): boolean {
  return (
    error instanceof PolicyAuthorityRefusalError ||
    (isObject(error) && error.code === POLICY_AUTHORITY_REFUSAL_CODE)
  );
}

/** Recognize a refusal caused by an externally managed observed policy. */
export function isExternalPolicyAuthorityRefusalError(error: unknown): boolean {
  return (
    isPolicyAuthorityRefusalError(error) &&
    isObject(error) &&
    error.observedAuthority === "externally-managed"
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
  try {
    return parseSandboxPolicyAuthorityMetadata(raw, validatedSandboxName);
  } catch (error) {
    failInspection(
      "sandbox",
      error instanceof Error ? error.message : "OpenShell returned invalid policy metadata",
    );
  }
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
  try {
    assertMatchingPolicyAuthority(recorded, observed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "policy authority is invalid";
    const observedAuthority =
      observed === "nemoclaw-managed" || observed === "externally-managed" ? observed : undefined;
    throw new PolicyAuthorityRefusalError(`Refusing to ${label}: ${detail}.`, observedAuthority);
  }
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
  const target = sandboxName ? ` for sandbox ${JSON.stringify(sandboxName)}` : "";
  try {
    assertExternalPolicyRequirementContainment(inspection, requiredPolicy);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "the policy requirement is invalid";
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${label}${target}: ${detail}. Ask the external policy authority to supply the exact required entries.`,
    );
  }
}

export const policyAuthorityInternals = {
  captureMaxBytes: POLICY_AUTHORITY_CAPTURE_MAX_BYTES,
  captureTimeoutMs: POLICY_AUTHORITY_CAPTURE_TIMEOUT_MS,
};
