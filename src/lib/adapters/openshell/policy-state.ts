// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  diagnosticPreview,
  isValidName,
  NAME_ALLOWED_FORMAT,
  NAME_MAX_LENGTH,
} from "../../sandbox-name-contract";
export { formatOpenShellPolicyRecoveryAction } from "../../gateway-start-guidance";
import * as openshellRuntime from "./runtime";
import { type OpenShellSandboxError } from "./sandbox-observer";
import { fingerprintOpenShellSandboxLiveIdentity } from "./sandbox-identity";
const POLICY_STATE_CAPTURE_MAX_BYTES = 1024 * 1024;
const POLICY_STATE_CAPTURE_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

const POLICY_OBSERVATION_ERROR_CODE = "NEMOCLAW_POLICY_OBSERVATION_ERROR";

/** A final failure while observing or validating live OpenShell policy. */
export class PolicyObservationError extends Error {
  readonly code = POLICY_OBSERVATION_ERROR_CODE;
  readonly policyReadError: OpenShellSandboxError | undefined;

  constructor(
    message: string,
    options?: ErrorOptions & { readonly policyReadError?: OpenShellSandboxError },
  ) {
    super(message, options);
    this.name = "PolicyObservationError";
    this.policyReadError = options?.policyReadError;
  }
}

/** Recognize live-policy observation failures across module boundaries. */
export function isPolicyObservationError(error: unknown): error is PolicyObservationError {
  return (
    error instanceof PolicyObservationError ||
    (isObject(error) &&
      error.code === POLICY_OBSERVATION_ERROR_CODE &&
      typeof error.message === "string")
  );
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

function failInspection(
  subject: "sandbox" | "global" | "gateway",
  reason: string | OpenShellSandboxError,
): never {
  const detail = typeof reason === "string" ? reason : reason.message;
  const punctuation = /[.!?]$/u.test(detail) ? "" : ".";
  throw new PolicyObservationError(
    `OpenShell ${subject} policy inspection failed: ${detail}${punctuation} Policy-dependent operations must stop.`,
    typeof reason === "string" ? undefined : { policyReadError: reason },
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
