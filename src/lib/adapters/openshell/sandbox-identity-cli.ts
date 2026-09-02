// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import {
  diagnosticPreview,
  isValidName,
  NAME_ALLOWED_FORMAT,
  NAME_MAX_LENGTH,
} from "../../sandbox-name-contract";
import { PolicyObservationError } from "./policy-state";
import { openshellNotFoundDiagnosticLines } from "./command-argv";
import { captureSanitizedResolvedOpenshell } from "./sanitized-capture";
import type { OpenShellSandboxError, OpenShellSandboxResult } from "./sandbox-observer";
import {
  classifyCliOpenShellCommandError,
  type CapturedOpenShellCommandResult,
} from "./sandbox-observer-cli";
import { fingerprintOpenShellSandboxLiveIdentity } from "./sandbox-identity";

const SANDBOX_IDENTITY_CAPTURE_MAX_BYTES = 1024 * 1024;
const SANDBOX_IDENTITY_CAPTURE_TIMEOUT_MS = 30_000;

type CaptureSandboxIdentityCommand = (
  args: string[],
  options: {
    readonly ignoreError: true;
    readonly includeStderr: true;
    readonly includeStreams: true;
    readonly maxBuffer: number;
    readonly timeout: number;
  },
) => CapturedOpenShellCommandResult;

type InspectSandboxIdentityRequest = Readonly<{
  sandboxName: string;
  gatewayName: string;
  timeoutMs?: number;
}>;

function validateIdentityName(name: string, label: string): string {
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

const IDENTITY_ERROR_MESSAGES = {
  authentication: "OpenShell could not authenticate the sandbox identity read.",
  command: "The OpenShell sandbox identity read failed.",
  schema: "The OpenShell CLI returned an invalid sandbox identity response.",
  timeout: "The OpenShell sandbox identity read timed out.",
  unavailable: () => openshellNotFoundDiagnosticLines().join("\n"),
} as const;

export function createSyncCliOpenShellSandboxIdentityInspector(deps: {
  readonly capture: CaptureSandboxIdentityCommand;
  readonly defaultTimeoutMs?: number;
}): (request: InspectSandboxIdentityRequest) => OpenShellSandboxResult<string> {
  return (request) => {
    const gatewayName = validateIdentityName(request.gatewayName, "gateway name");
    const sandboxName = validateIdentityName(request.sandboxName, "sandbox name");
    assertNoOpenShellGatewayEndpointOverride();
    const captured = deps.capture(["sandbox", "get", "-g", gatewayName, sandboxName], {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      maxBuffer: SANDBOX_IDENTITY_CAPTURE_MAX_BYTES,
      timeout: request.timeoutMs ?? deps.defaultTimeoutMs ?? SANDBOX_IDENTITY_CAPTURE_TIMEOUT_MS,
    });
    const error = classifyCliOpenShellCommandError(captured, IDENTITY_ERROR_MESSAGES);
    if (error) return { ok: false, error };
    const fingerprint = fingerprintOpenShellSandboxLiveIdentity(captured.stdout ?? captured.output);
    return fingerprint === null
      ? { ok: false, error: { kind: "schema", message: IDENTITY_ERROR_MESSAGES.schema } }
      : { ok: true, value: fingerprint };
  };
}

const syncCliOpenShellSandboxIdentityInspector = createSyncCliOpenShellSandboxIdentityInspector({
  capture: captureSanitizedResolvedOpenshell,
});

/** Read and fingerprint one sandbox ID without exposing the ID in diagnostics. */
export function inspectOpenShellSandboxIdentityFingerprint(
  request: InspectSandboxIdentityRequest,
): string {
  const result = syncCliOpenShellSandboxIdentityInspector(request);
  if (result.ok) return result.value;
  throw new PolicyObservationError(
    `OpenShell sandbox identity inspection failed: ${result.error.message}`,
    { policyReadError: result.error },
  );
}
