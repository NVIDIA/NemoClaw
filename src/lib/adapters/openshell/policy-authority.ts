// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  diagnosticPreview,
  isValidName,
  NAME_ALLOWED_FORMAT,
  NAME_MAX_LENGTH,
} from "../../sandbox-name-contract";
import {
  parseActiveGlobalPolicyAuthorityMetadata,
  type ActiveGlobalPolicyInspection,
  type OpenShellPolicyAuthority,
  parseSandboxPolicyAuthorityMetadata,
  type SandboxPolicyAuthorityInspection as CanonicalSandboxPolicyAuthorityInspection,
} from "../../../../nemoclaw/dist/shared/openshell-policy-boundary.cjs";
import * as openshellRuntime from "./runtime";
import { fingerprintOpenShellSandboxLiveIdentity } from "./sandbox-identity";
const POLICY_AUTHORITY_CAPTURE_MAX_BYTES = 1024 * 1024;
const POLICY_AUTHORITY_CAPTURE_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

export type SandboxPolicyAuthority = OpenShellPolicyAuthority;
export type SandboxPolicyAuthorityInspection = CanonicalSandboxPolicyAuthorityInspection;
export type { ActiveGlobalPolicyInspection };

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

interface ActiveGlobalPolicyInspectionOptions {
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

function failInspection(subject: "sandbox" | "global" | "gateway", reason: string): never {
  throw new PolicyAuthorityRefusalError(
    `OpenShell ${subject} policy authority inspection failed: ${reason}. Policy-dependent operations must stop.`,
  );
}

function captureBoundedOpenShell(
  args: string[],
  subject: "sandbox" | "global" | "gateway",
): ReturnType<typeof openshellRuntime.captureResolvedOpenshell> {
  try {
    return openshellRuntime.captureResolvedOpenshell(args, {
      env: openshellRuntime.buildOpenShellSubprocessEnv(),
      ignoreError: true,
      includeStreams: true,
      maxBuffer: POLICY_AUTHORITY_CAPTURE_MAX_BYTES,
      replaceEnv: true,
      timeout: POLICY_AUTHORITY_CAPTURE_TIMEOUT_MS,
    });
  } catch {
    failInspection(subject, "the policy query could not run");
  }
}

function captureAuthorityRead(
  args: string[],
  subject: "sandbox" | "global" | "gateway",
): { readonly output: string; readonly stdout: string; readonly stderr: string } {
  const result = captureBoundedOpenShell(args, subject);
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ETIMEDOUT") {
    failInspection(subject, "the policy query timed out");
  }
  if (errorCode === "ENOBUFS") {
    failInspection(subject, "the policy response exceeded the capture limit");
  }
  if (result.error) {
    failInspection(subject, "the policy query could not run");
  }
  if (result.status !== 0) {
    failInspection(subject, "the policy query did not complete successfully");
  }
  return { output: result.output, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function capturePolicyRead(args: string[], subject: "sandbox" | "global"): string {
  return captureAuthorityRead(args, subject).stdout;
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
  const raw = capturePolicyRead(
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

/** Inspect active global policy presence without assigning absent policy ownership. */
export function inspectActiveGlobalPolicy({
  gatewayName,
}: ActiveGlobalPolicyInspectionOptions = {}): ActiveGlobalPolicyInspection {
  const validatedGatewayName =
    gatewayName === undefined
      ? undefined
      : validatePolicyAuthorityName(gatewayName, "gateway name");
  const history = capturePolicyRead(
    [
      "policy",
      "list",
      ...(validatedGatewayName ? ["-g", validatedGatewayName] : []),
      "--global",
      "--limit",
      "1",
    ],
    "global",
  );
  if (history.trim().length === 0) return { state: "absent" };
  const raw = capturePolicyRead(
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
  );
  try {
    return parseActiveGlobalPolicyAuthorityMetadata(raw);
  } catch (error) {
    failInspection(
      "global",
      error instanceof Error ? error.message : "OpenShell returned invalid policy metadata",
    );
  }
}

/** Read one sandbox base policy through the same bounded OpenShell adapter. */
export function captureSandboxBasePolicy(sandboxName: string, gatewayName: string): string {
  const validatedSandboxName = validatePolicyAuthorityName(sandboxName, "sandbox name");
  const validatedGatewayName = validatePolicyAuthorityName(gatewayName, "gateway name");
  return capturePolicyRead(
    ["policy", "get", "-g", validatedGatewayName, "--base", validatedSandboxName],
    "sandbox",
  );
}

/** Read and fingerprint one sandbox ID without exposing the ID in diagnostics. */
export function inspectOpenShellSandboxIdentityFingerprint(options: {
  readonly sandboxName: string;
  readonly gatewayName: string;
}): string {
  const gatewayName = validatePolicyAuthorityName(options.gatewayName, "gateway name");
  const sandboxName = validatePolicyAuthorityName(options.sandboxName, "sandbox name");
  let result: ReturnType<typeof openshellRuntime.captureResolvedOpenshell>;
  try {
    result = captureBoundedOpenShell(["sandbox", "get", "-g", gatewayName, sandboxName], "sandbox");
  } catch {
    throw new Error("OpenShell sandbox identity inspection could not run");
  }
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("OpenShell sandbox identity inspection did not complete successfully");
  }
  const fingerprint = fingerprintOpenShellSandboxLiveIdentity(result.stdout ?? "");
  if (fingerprint === null) {
    throw new Error("OpenShell did not return one exact durable sandbox ID");
  }
  return fingerprint;
}

/** Require the named live OpenShell gateway to expose the receipt-bound local port. */
export function assertOpenShellGatewayPortBinding(options: {
  readonly gatewayName: string;
  readonly gatewayPort: number;
}): void {
  const gatewayName = validatePolicyAuthorityName(options.gatewayName, "gateway name");
  if (
    !Number.isSafeInteger(options.gatewayPort) ||
    options.gatewayPort < 1 ||
    options.gatewayPort > 65_535
  ) {
    failInspection("gateway", "the expected gateway port is invalid");
  }
  const result = captureAuthorityRead(["gateway", "info", "-g", gatewayName], "gateway");
  if (
    openshellRuntime.classifyManagedGatewayEndpointBinding([result.output], options.gatewayPort) !==
    "match"
  ) {
    failInspection("gateway", "the live endpoint does not match the recorded gateway port");
  }
}

export const policyAuthorityInternals = {
  captureMaxBytes: POLICY_AUTHORITY_CAPTURE_MAX_BYTES,
  captureTimeoutMs: POLICY_AUTHORITY_CAPTURE_TIMEOUT_MS,
};
