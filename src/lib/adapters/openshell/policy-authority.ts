// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  diagnosticPreview,
  isValidName,
  NAME_ALLOWED_FORMAT,
  NAME_MAX_LENGTH,
} from "../../sandbox-name-contract";
import {
  type OpenShellPolicyAuthority,
  parseGlobalPolicyAuthorityMetadata,
  parseSandboxPolicyAuthorityMetadata,
  type SandboxPolicyAuthorityInspection as CanonicalSandboxPolicyAuthorityInspection,
} from "../../../../nemoclaw/dist/shared/openshell-policy-boundary.cjs";
import * as openshellRuntime from "./runtime";
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

  constructor(message: string, observedAuthority?: SandboxPolicyAuthority, options?: ErrorOptions) {
    super(message, options);
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

interface SandboxPolicyAuthorityInspectionOptions {
  readonly sandboxName: string;
  readonly gatewayName?: string;
}

interface GlobalPolicyAuthorityInspectionOptions {
  readonly gatewayName?: string;
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
  args: string[],
  subject: "sandbox" | "global",
  queryKind: "machine-readable policy" | "policy history",
): string {
  let result: ReturnType<typeof openshellRuntime.captureResolvedOpenshell>;
  try {
    result = openshellRuntime.captureResolvedOpenshell(args, {
      env: openshellRuntime.buildOpenShellSubprocessEnv(),
      ignoreError: true,
      includeStreams: true,
      maxBuffer: POLICY_AUTHORITY_CAPTURE_MAX_BYTES,
      replaceEnv: true,
      timeout: POLICY_AUTHORITY_CAPTURE_TIMEOUT_MS,
    });
  } catch {
    failInspection(subject, `the ${queryKind} query could not run`);
  }

  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ENOBUFS") {
    failInspection(subject, `the ${queryKind} response exceeded the capture limit`);
  }
  if (errorCode === "ETIMEDOUT") {
    failInspection(subject, `the ${queryKind} query timed out`);
  }
  if (result.error) {
    failInspection(subject, `the ${queryKind} query could not run`);
  }
  if (result.status !== 0) {
    failInspection(subject, `the ${queryKind} query did not complete successfully`);
  }
  return result.stdout ?? "";
}

/** Inspect the effective policy source for one live sandbox. */
export function inspectSandboxPolicyAuthority({
  sandboxName,
  gatewayName,
}: SandboxPolicyAuthorityInspectionOptions): SandboxPolicyAuthorityInspection {
  const validatedSandboxName = validatePolicyAuthorityName(sandboxName, "sandbox name");
  const validatedGatewayName =
    gatewayName === undefined
      ? undefined
      : validatePolicyAuthorityName(gatewayName, "gateway name");
  const raw = capturePolicyQuery(
    [
      "policy",
      "get",
      ...(validatedGatewayName ? ["-g", validatedGatewayName] : []),
      "--full",
      "--output",
      "json",
      validatedSandboxName,
    ],
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

/** Inspect whether an active global policy will manage a sandbox created next. */
export function inspectGlobalPolicyAuthority({
  gatewayName,
}: GlobalPolicyAuthorityInspectionOptions = {}): SandboxPolicyAuthorityInspection {
  const validatedGatewayName =
    gatewayName === undefined
      ? undefined
      : validatePolicyAuthorityName(gatewayName, "gateway name");
  const history = capturePolicyQuery(
    [
      "policy",
      "list",
      ...(validatedGatewayName ? ["-g", validatedGatewayName] : []),
      "--global",
      "--limit",
      "1",
    ],
    "global",
    "policy history",
  );
  if (history.trim().length === 0) {
    return { authority: "nemoclaw-managed", effectivePolicy: {} };
  }
  const raw = capturePolicyQuery(
    [
      "policy",
      "get",
      ...(validatedGatewayName ? ["-g", validatedGatewayName] : []),
      "--global",
      "--full",
      "--output",
      "json",
    ],
    "global",
    "machine-readable policy",
  );
  try {
    return parseGlobalPolicyAuthorityMetadata(raw);
  } catch (error) {
    failInspection(
      "global",
      error instanceof Error ? error.message : "OpenShell returned invalid policy metadata",
    );
  }
}

export const policyAuthorityInternals = {
  captureMaxBytes: POLICY_AUTHORITY_CAPTURE_MAX_BYTES,
  captureTimeoutMs: POLICY_AUTHORITY_CAPTURE_TIMEOUT_MS,
};
