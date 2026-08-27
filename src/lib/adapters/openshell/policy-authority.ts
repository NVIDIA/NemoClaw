// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  diagnosticPreview,
  isValidName,
  NAME_ALLOWED_FORMAT,
  NAME_MAX_LENGTH,
} from "../../sandbox-name-contract";
import {
  buildGlobalPolicyGetFullJsonArgs,
  buildGlobalPolicyListArgs,
  buildPolicyGetArgs,
  buildPolicyGetFullJsonArgs,
} from "../../policy/commands";
import {
  assertExternalPolicyRequirementContainment,
  assertMatchingPolicyAuthority,
  assertPolicyRequirementContainment,
  classifyOpenShellGlobalPolicyHistory,
  parseActiveGlobalPolicyAuthorityMetadata,
  type ActiveGlobalPolicyInspection,
  type OpenShellPolicyAuthority,
  parseSandboxPolicyAuthorityMetadata,
  type SandboxPolicyAuthorityInspection as CanonicalSandboxPolicyAuthorityInspection,
} from "../../policy/merge";
import * as openshellRuntime from "./runtime";
import {
  fingerprintOpenShellSandboxId,
  fingerprintOpenShellSandboxLiveIdentity,
  parseStrictOpenShellSandboxListJson,
} from "./sandbox-identity";
const POLICY_AUTHORITY_CAPTURE_MAX_BYTES = 1024 * 1024;
const POLICY_AUTHORITY_CAPTURE_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

export type SandboxPolicyAuthority = OpenShellPolicyAuthority;
export type SandboxPolicyAuthorityInspection = CanonicalSandboxPolicyAuthorityInspection;
export type { ActiveGlobalPolicyInspection } from "../../policy/merge";

export type OpenShellSandboxPolicyReadiness =
  | { readonly state: "ready" }
  | {
      readonly state: "transient";
      readonly reason: "sandbox-not-ready" | "policy-version-pending";
    };

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
  runtimeSelection?: { readonly gatewayName?: string },
): ReturnType<typeof openshellRuntime.captureResolvedOpenshell> {
  const env = openshellRuntime.buildOpenShellSubprocessEnv();
  if (runtimeSelection !== undefined) {
    for (const name of ["XDG_CONFIG_HOME", "OPENSHELL_WORKSPACE"] as const) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    if (runtimeSelection.gatewayName !== undefined) {
      env.OPENSHELL_GATEWAY = runtimeSelection.gatewayName;
    }
  }
  try {
    return openshellRuntime.captureResolvedOpenshell(args, {
      env,
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
  runtimeSelection?: { readonly gatewayName?: string },
): { readonly output: string; readonly stdout: string; readonly stderr: string } {
  const result = captureBoundedOpenShell(args, subject, runtimeSelection);
  if (
    !isObject(result) ||
    typeof result.output !== "string" ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    failInspection(subject, "the policy query returned an invalid result");
  }
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
  return { output: result.output, stdout: result.stdout, stderr: result.stderr };
}

function capturePolicyRead(
  args: string[],
  subject: "sandbox" | "global",
  runtimeSelection?: { readonly gatewayName?: string },
): string {
  return captureAuthorityRead(args, subject, runtimeSelection).stdout;
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
    buildPolicyGetFullJsonArgs(validatedSandboxName, validatedGatewayName),
    "sandbox",
    { gatewayName: validatedGatewayName },
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

/**
 * Bind one effective policy version to the exact live Ready sandbox row.
 * A phase or version lag is an explicit convergence state; malformed,
 * ambiguous, or replacement identity observations fail closed.
 */
export function inspectOpenShellSandboxPolicyReadiness(options: {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly sandboxIdentityFingerprint: string;
  readonly policyVersion: number;
}): OpenShellSandboxPolicyReadiness {
  const sandboxName = validatePolicyAuthorityName(options.sandboxName, "sandbox name");
  const gatewayName = validatePolicyAuthorityName(options.gatewayName, "gateway name");
  if (!/^[0-9a-f]{64}$/u.test(options.sandboxIdentityFingerprint)) {
    failInspection("sandbox", "the expected sandbox identity is invalid");
  }
  if (!Number.isSafeInteger(options.policyVersion) || options.policyVersion < 0) {
    failInspection("sandbox", "the expected policy version is invalid");
  }
  const result = captureAuthorityRead(
    ["sandbox", "list", "-g", gatewayName, "--output", "json", "--limit", "1000"],
    "sandbox",
    { gatewayName },
  );
  const rows = parseStrictOpenShellSandboxListJson(result.stdout);
  if (!rows) failInspection("sandbox", "OpenShell returned invalid sandbox readiness metadata");
  const matches = rows.filter((row) => row.name === sandboxName);
  if (matches.length !== 1) {
    failInspection("sandbox", "OpenShell did not return one exact sandbox readiness row");
  }
  const row = matches[0]!;
  if (fingerprintOpenShellSandboxId(row.id) !== options.sandboxIdentityFingerprint) {
    failInspection("sandbox", "the live sandbox identity changed during policy verification");
  }
  if (row.phase !== "Ready") {
    return { state: "transient", reason: "sandbox-not-ready" };
  }
  if (row.current_policy_version !== options.policyVersion) {
    return { state: "transient", reason: "policy-version-pending" };
  }
  return { state: "ready" };
}

/** Inspect active global policy presence without assigning absent policy ownership. */
export function inspectActiveGlobalPolicy({
  gatewayName,
}: ActiveGlobalPolicyInspectionOptions = {}): ActiveGlobalPolicyInspection {
  const validatedGatewayName =
    gatewayName === undefined
      ? undefined
      : validatePolicyAuthorityName(gatewayName, "gateway name");
  const history = captureAuthorityRead(buildGlobalPolicyListArgs(validatedGatewayName), "global", {
    gatewayName: validatedGatewayName,
  });
  const historyState = classifyOpenShellGlobalPolicyHistory(history.stdout, history.stderr);
  if (historyState === "absent") return { state: "absent" };
  if (historyState === "invalid") {
    failInspection("global", "OpenShell returned invalid global policy history");
  }
  const raw = captureAuthorityRead(
    buildGlobalPolicyGetFullJsonArgs(validatedGatewayName),
    "global",
    { gatewayName: validatedGatewayName },
  ).stdout;
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
  const validatedGatewayName = validatePolicyAuthorityName(gatewayName, "gateway name");
  return capturePolicyRead(
    buildPolicyGetArgs(
      validatePolicyAuthorityName(sandboxName, "sandbox name"),
      validatedGatewayName,
    ),
    "sandbox",
    { gatewayName: validatedGatewayName },
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
    result = captureBoundedOpenShell(
      ["sandbox", "get", "-g", gatewayName, sandboxName],
      "sandbox",
      { gatewayName },
    );
  } catch {
    throw new Error("OpenShell sandbox identity inspection could not run");
  }
  if (
    !isObject(result) ||
    typeof result.stdout !== "string" ||
    result.error !== undefined ||
    result.status !== 0
  ) {
    throw new Error("OpenShell sandbox identity inspection did not complete successfully");
  }
  const fingerprint = fingerprintOpenShellSandboxLiveIdentity(result.stdout);
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
  const result = captureAuthorityRead(["gateway", "info", "-g", gatewayName], "gateway", {
    gatewayName,
  });
  if (
    openshellRuntime.classifyManagedGatewayEndpointBinding([result.output], options.gatewayPort) !==
    "match"
  ) {
    failInspection("gateway", "the live endpoint does not match the recorded gateway port");
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

/** Verify required entries without assigning ownership to a sandbox-scoped policy. */
export function assertObservedPolicyRequirements({
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
    assertPolicyRequirementContainment(inspection, requiredPolicy);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "the policy requirement is invalid";
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${label}${target}: ${detail}. The verified policy must supply the exact required entries.`,
    );
  }
}

export const policyAuthorityInternals = {
  captureMaxBytes: POLICY_AUTHORITY_CAPTURE_MAX_BYTES,
  captureTimeoutMs: POLICY_AUTHORITY_CAPTURE_TIMEOUT_MS,
};
