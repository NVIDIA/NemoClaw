// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  diagnosticPreview,
  isValidName,
  NAME_ALLOWED_FORMAT,
  NAME_MAX_LENGTH,
} from "../../sandbox-name-contract";
import { buildGlobalPolicyGetFullJsonArgs, buildGlobalPolicyListArgs } from "../../policy/commands";
import {
  assertPolicyRequirementContainment,
  classifyOpenShellGlobalPolicyHistory,
  parseActiveGlobalPolicyMetadata,
  type ActiveGlobalPolicyInspection,
  type OpenShellPolicyInspection,
} from "../../policy/merge";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
export { formatOpenShellPolicyRecoveryAction } from "../../gateway-start-guidance";
import * as openshellRuntime from "./runtime";
import {
  createSyncCliOpenShellSandboxPolicyReader,
  type SyncCapturePolicyCommand,
} from "./sandbox-policy-cli";
import { namedOpenShellGateway, selectedOpenShellGateway } from "./sandbox-observer";
import { fingerprintOpenShellSandboxLiveIdentity } from "./sandbox-identity";
const POLICY_STATE_CAPTURE_MAX_BYTES = 1024 * 1024;
const POLICY_STATE_CAPTURE_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

export type SandboxPolicyInspection = OpenShellPolicyInspection;
export type { ActiveGlobalPolicyInspection } from "../../policy/merge";

const POLICY_OBSERVATION_ERROR_CODE = "NEMOCLAW_POLICY_OBSERVATION_ERROR";

/** A final failure while observing or validating live OpenShell policy. */
export class PolicyObservationError extends Error {
  readonly code = POLICY_OBSERVATION_ERROR_CODE;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PolicyObservationError";
  }
}

/** Recognize live-policy observation failures across module boundaries. */
export function isPolicyObservationError(error: unknown): boolean {
  return (
    error instanceof PolicyObservationError ||
    (isObject(error) && error.code === POLICY_OBSERVATION_ERROR_CODE)
  );
}

interface SandboxPolicyInspectionOptions {
  readonly sandboxName: string;
  readonly gatewayName?: string;
}

interface ActiveGlobalPolicyInspectionOptions {
  readonly gatewayName?: string;
}

function validatePolicyName(name: string, label: string): string {
  if (!name || typeof name !== "string") {
    throw new PolicyObservationError(
      `${label} is required. Allowed format: ${NAME_ALLOWED_FORMAT}.`,
    );
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw new PolicyObservationError(
      `${label} too long (max ${NAME_MAX_LENGTH} chars): ${diagnosticPreview(name)}. Allowed format: ${NAME_ALLOWED_FORMAT}.`,
    );
  }
  if (isValidName(name)) return name;
  throw new PolicyObservationError(
    `Invalid ${label}: ${diagnosticPreview(name)}. Allowed format: ${NAME_ALLOWED_FORMAT}.`,
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failInspection(subject: "sandbox" | "global" | "gateway", reason: string): never {
  throw new PolicyObservationError(
    `OpenShell ${subject} policy inspection failed: ${reason}. Policy-dependent operations must stop.`,
  );
}

function captureBoundedOpenShell(
  args: string[],
  subject: "sandbox" | "global" | "gateway",
  runtimeSelection?: { readonly gatewayName?: string },
  timeoutMs = POLICY_STATE_CAPTURE_TIMEOUT_MS,
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
      maxBuffer: POLICY_STATE_CAPTURE_MAX_BYTES,
      replaceEnv: true,
      timeout: timeoutMs,
    });
  } catch {
    failInspection(subject, "the policy query could not run");
  }
}

/** Read one policy document through the canonical synchronous CLI boundary. */
export function readSandboxPolicyWithCapture(input: {
  readonly capture: SyncCapturePolicyCommand;
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly scope: "base" | "effective";
  readonly timeoutMs?: number;
}): ReturnType<ReturnType<typeof createSyncCliOpenShellSandboxPolicyReader>["readSandboxPolicy"]> {
  assertNoOpenShellGatewayEndpointOverride();
  const sandboxName = validatePolicyName(input.sandboxName, "sandbox name");
  const gatewayName = validatePolicyName(input.gatewayName, "gateway name");
  return createSyncCliOpenShellSandboxPolicyReader({ capture: input.capture }).readSandboxPolicy({
    target: namedOpenShellGateway(gatewayName),
    sandboxName,
    scope: input.scope,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
}

function captureSandboxPolicyDocument(input: {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly scope: "base" | "effective";
  readonly timeoutMs?: number;
}): string {
  const result = readSandboxPolicyWithCapture({
    ...input,
    capture: (args, options) =>
      captureBoundedOpenShell(args, "sandbox", { gatewayName: input.gatewayName }, options.timeout),
  });
  if (!result.ok) failInspection("sandbox", result.error.message);
  return result.value.document;
}

function createBoundSandboxPolicyReader(gatewayName?: string) {
  if (gatewayName !== undefined) assertNoOpenShellGatewayEndpointOverride();
  return createSyncCliOpenShellSandboxPolicyReader({
    capture: (args, options) =>
      captureBoundedOpenShell(args, "sandbox", { gatewayName }, options.timeout),
    defaultTimeoutMs: POLICY_STATE_CAPTURE_TIMEOUT_MS,
  });
}

function sandboxPolicyTarget(gatewayName?: string) {
  return gatewayName ? namedOpenShellGateway(gatewayName) : selectedOpenShellGateway();
}

function capturePolicyCommand(
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

/** Inspect the effective policy source for one live sandbox. */
export function inspectSandboxPolicy({
  sandboxName,
  gatewayName,
}: SandboxPolicyInspectionOptions): SandboxPolicyInspection {
  const validatedSandboxName = validatePolicyName(sandboxName, "sandbox name");
  const validatedGatewayName =
    gatewayName === undefined ? undefined : validatePolicyName(gatewayName, "gateway name");
  const result = createBoundSandboxPolicyReader(validatedGatewayName).inspectSandboxPolicy({
    target: sandboxPolicyTarget(validatedGatewayName),
    sandboxName: validatedSandboxName,
  });
  if (!result.ok) failInspection("sandbox", result.error.message);
  return result.value;
}

/** Inspect active global policy presence without assigning absent policy ownership. */
export function inspectActiveGlobalPolicy({
  gatewayName,
}: ActiveGlobalPolicyInspectionOptions = {}): ActiveGlobalPolicyInspection {
  const validatedGatewayName =
    gatewayName === undefined ? undefined : validatePolicyName(gatewayName, "gateway name");
  const history = capturePolicyCommand(buildGlobalPolicyListArgs(validatedGatewayName), "global", {
    gatewayName: validatedGatewayName,
  });
  const historyState = classifyOpenShellGlobalPolicyHistory(history.stdout, history.stderr);
  if (historyState === "absent") return { state: "absent" };
  if (historyState === "invalid") {
    failInspection("global", "OpenShell returned invalid global policy history");
  }
  const raw = capturePolicyCommand(
    buildGlobalPolicyGetFullJsonArgs(validatedGatewayName),
    "global",
    { gatewayName: validatedGatewayName },
  ).stdout;
  try {
    return parseActiveGlobalPolicyMetadata(raw);
  } catch (error) {
    failInspection(
      "global",
      error instanceof Error ? error.message : "OpenShell returned invalid policy metadata",
    );
  }
}

/** Read one sandbox base policy through the same bounded OpenShell adapter. */
export function captureSandboxBasePolicy(sandboxName: string, gatewayName: string): string {
  return captureSandboxPolicyDocument({
    sandboxName,
    gatewayName,
    scope: "base",
    timeoutMs: POLICY_STATE_CAPTURE_TIMEOUT_MS,
  });
}

/** Read one effective sandbox policy through the shared typed CLI boundary. */
export function captureSandboxEffectivePolicy(
  sandboxName: string,
  gatewayName: string,
  timeoutMs?: number,
): string {
  return captureSandboxPolicyDocument({
    sandboxName,
    gatewayName,
    scope: "effective",
    timeoutMs: timeoutMs ?? POLICY_STATE_CAPTURE_TIMEOUT_MS,
  });
}

/** Read one immutable base-policy revision through the selected gateway. */
export function captureSandboxBasePolicyRevision(
  sandboxName: string,
  gatewayName: string,
  revision: number,
): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    failInspection("sandbox", "the requested policy revision is invalid");
  }
  const validatedSandboxName = validatePolicyName(sandboxName, "sandbox name");
  const validatedGatewayName = validatePolicyName(gatewayName, "gateway name");
  const result = createBoundSandboxPolicyReader(validatedGatewayName).readSandboxPolicyRevision({
    target: namedOpenShellGateway(validatedGatewayName),
    sandboxName: validatedSandboxName,
    revision,
  });
  if (!result.ok) failInspection("sandbox", result.error.message);
  return result.value.document;
}

/** Read and fingerprint one sandbox ID without exposing the ID in diagnostics. */
export function inspectOpenShellSandboxIdentityFingerprint(options: {
  readonly sandboxName: string;
  readonly gatewayName: string;
}): string {
  const gatewayName = validatePolicyName(options.gatewayName, "gateway name");
  const sandboxName = validatePolicyName(options.sandboxName, "sandbox name");
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

/** Require the named live OpenShell gateway to expose the expected local port. */
export function assertOpenShellGatewayPortBinding(options: {
  readonly gatewayName: string;
  readonly gatewayPort: number;
}): void {
  const gatewayName = validatePolicyName(options.gatewayName, "gateway name");
  if (
    !Number.isSafeInteger(options.gatewayPort) ||
    options.gatewayPort < 1 ||
    options.gatewayPort > 65_535
  ) {
    failInspection("gateway", "the expected gateway port is invalid");
  }
  const result = capturePolicyCommand(["gateway", "info", "-g", gatewayName], "gateway", {
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

/** Verify that the current OpenShell policy contains required entries and sections. */
export function assertObservedPolicyRequirements({
  inspection,
  requiredPolicy,
  operation,
  sandboxName,
}: {
  readonly inspection: SandboxPolicyInspection;
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
    throw new PolicyObservationError(
      `Refusing to ${label}${target}: ${detail}. The verified policy must supply the exact required entries.`,
    );
  }
}

export const policyStateInternals = {
  captureMaxBytes: POLICY_STATE_CAPTURE_MAX_BYTES,
  captureTimeoutMs: POLICY_STATE_CAPTURE_TIMEOUT_MS,
};
