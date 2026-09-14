// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertNoOpenShellGatewayEndpointOverride,
  OpenShellGatewayEndpointOverrideError,
  scopeGatewayOpenshellArgs,
  type OpenShellGatewayEndpointEnvironment,
} from "./gateway-scope";
import {
  type OpenShellInferenceRouteError,
  type OpenShellInferenceRouteObservation,
  type OpenShellInferenceRouteObserver,
  type OpenShellInferenceRouteResult,
  type OpenShellInferenceRouteTarget,
  type OpenShellSynchronousInferenceRouteObserver,
  type ObserveOpenShellInferenceRouteRequest,
} from "./inference-route";

const BASE_GATEWAY_NAME = "nemoclaw";
const CAPTURE_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const TERMINAL_OSC_RE = /(?:\x1B\]|\x9D)[\s\S]*?(?:\x07|\x1B\\|\x9C|$)/gu;
const TERMINAL_STRING_RE = /(?:\x1B[PX^_]|[\x90\x98\x9E\x9F])[\s\S]*?(?:\x1B\\|\x9C|$)/gu;
const TERMINAL_CSI_RE = /(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/gu;
const TERMINAL_CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

export type CaptureOpenShellInferenceRoute = (
  args: string[],
  options: {
    ignoreError: true;
    includeStderr: true;
    includeStreams: true;
    maxBuffer: number;
    timeout: number;
  },
) => CapturedOpenShellInferenceRouteResult | Promise<CapturedOpenShellInferenceRouteResult>;

export type CaptureOpenShellInferenceRouteSynchronously = (
  args: string[],
  options: {
    ignoreError: true;
    includeStderr: true;
    includeStreams: true;
    maxBuffer: number;
    timeout: number;
  },
) => CapturedOpenShellInferenceRouteResult;

export type CliOpenShellInferenceRouteObserverOptions = Readonly<{
  allowLegacySelectedFallback?: boolean;
  environment?: OpenShellGatewayEndpointEnvironment;
}>;

type CapturedOpenShellInferenceRouteResult = Readonly<{
  status: number | null;
  output: string;
  stdout?: string;
  stderr?: string;
  error?: Error;
}>;

function success(value: OpenShellInferenceRouteObservation): OpenShellInferenceRouteResult {
  return { ok: true, value };
}

function failure(error: OpenShellInferenceRouteError): OpenShellInferenceRouteResult {
  return { ok: false, error };
}

function cleanTerminalText(value: string): string {
  return String(value)
    .replace(TERMINAL_OSC_RE, "")
    .replace(TERMINAL_STRING_RE, "")
    .replace(TERMINAL_CSI_RE, "")
    .replace(TERMINAL_CONTROL_RE, "");
}

function commandOutput(result: CapturedOpenShellInferenceRouteResult): string {
  return `${result.stderr ?? ""}\n${result.stdout ?? result.output ?? ""}`.trim();
}

function successfulOutput(result: CapturedOpenShellInferenceRouteResult): string {
  return cleanTerminalText(result.stdout ?? result.output ?? "").trim();
}

function routeError(
  result: CapturedOpenShellInferenceRouteResult,
): OpenShellInferenceRouteError | null {
  const output = cleanTerminalText(commandOutput(result));
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ENOENT" || errorCode === "EACCES") {
    return {
      kind: "transport",
      reason: "process_start",
      message: "OpenShell could not start the inference route observation.",
    };
  }
  if (errorCode === "ETIMEDOUT") {
    return { kind: "timeout", message: "OpenShell inference route observation timed out." };
  }
  const effectiveStatus = result.status === 0 && /^\s*Error:/imu.test(output) ? 1 : result.status;
  if (/invalid wire type|proto(?:buf)?(?: decode| schema| wire)/iu.test(output)) {
    return {
      kind: "schema",
      reason: "protocol_mismatch",
      message: "The OpenShell CLI and gateway inference schemas do not match.",
    };
  }
  if (effectiveStatus === 0 && !result.error) return null;
  if (
    /\b(?:authentication failed|unauthorized|forbidden|permission denied|requires admin privileges|missing gateway auth token|device identity required|invalid token|expired token)\b/iu.test(
      output,
    )
  ) {
    return {
      kind: "authentication",
      message: "OpenShell could not authenticate the inference route observation.",
    };
  }
  if (/\bhandshake verification failed\b/iu.test(output)) {
    return {
      kind: "transport",
      reason: "identity_mismatch",
      message: "The selected OpenShell gateway identity does not match the recorded identity.",
    };
  }
  if (
    /\b(?:connection refused|client error \(connect\)|tcp connect error|transport error|connection reset|connection aborted|connection closed|no active gateway|no gateway configured|unknown gateway)\b|status:\s*disconnected/iu.test(
      output,
    )
  ) {
    return {
      kind: "transport",
      reason: "unreachable",
      message: "OpenShell could not reach the selected gateway.",
    };
  }
  if (effectiveStatus === null) {
    return {
      kind: "command",
      reason: "indeterminate",
      message: "OpenShell inference route observation ended before an exit status was available.",
    };
  }
  const reason = effectiveStatus === 2 ? "invalid_request" : "failed";
  return {
    kind: "command",
    reason,
    message: `OpenShell inference route observation failed with exit status ${String(effectiveStatus)}.`,
  };
}

function parseRoute(output: string): OpenShellInferenceRouteResult {
  const lines = output.split(/\r?\n/u);
  const hasInferenceSection = lines.some((line) => /^(?:Gateway )?Inference:\s*$/iu.test(line));
  let sectionCount = 0;
  let inInferenceSection = !hasInferenceSection;
  let provider: string | null = null;
  let model: string | null = null;
  let unconfigured = false;
  for (const line of lines) {
    if (/^(?:Gateway )?Inference:\s*$/iu.test(line)) {
      sectionCount += 1;
      inInferenceSection = true;
      continue;
    }
    if (inInferenceSection && /^\S.*:$/u.test(line)) {
      inInferenceSection = false;
      continue;
    }
    if (!inInferenceSection) continue;
    const trimmed = line.trim();
    const providerMatch = trimmed.match(/^Provider:\s*(.+)$/u);
    const modelMatch = trimmed.match(/^Model:\s*(.+)$/u);
    if (providerMatch) provider = provider === null ? providerMatch[1].trim() : "";
    if (modelMatch) model = model === null ? modelMatch[1].trim() : "";
    if (/^Not configured$/iu.test(trimmed)) unconfigured = true;
  }
  if (sectionCount > 1 || (unconfigured && (provider !== null || model !== null))) {
    return failure({
      kind: "schema",
      reason: "malformed_output",
      message: "OpenShell returned an unrecognized inference route observation.",
    });
  }
  if (unconfigured) return success({ state: "unconfigured" });
  if (provider && model) return success({ state: "configured", route: { provider, model } });
  if (provider !== null || model !== null) {
    return failure({
      kind: "schema",
      reason: "partial_route",
      message: "OpenShell returned an incomplete inference route.",
    });
  }
  return failure({
    kind: "schema",
    reason: "malformed_output",
    message: "OpenShell returned an unrecognized inference route observation.",
  });
}

function argsFor(target: OpenShellInferenceRouteTarget): string[] {
  const args = ["inference", "get"];
  return target.kind === "named" ? scopeGatewayOpenshellArgs(args, target.gatewayName) : args;
}

function validateRequest(
  request: ObserveOpenShellInferenceRouteRequest,
  environment: OpenShellGatewayEndpointEnvironment,
): OpenShellInferenceRouteError | null {
  if (
    (request.target.kind === "named" &&
      (!request.target.gatewayName || /[\u0000-\u001F\u007F]/u.test(request.target.gatewayName))) ||
    (request.timeoutMs !== undefined &&
      (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0))
  ) {
    return {
      kind: "validation",
      message: "Invalid OpenShell inference route target or timeout.",
    };
  }
  if (request.target.kind === "selected") return null;
  try {
    assertNoOpenShellGatewayEndpointOverride(environment);
    return null;
  } catch (error) {
    if (!(error instanceof OpenShellGatewayEndpointOverrideError)) throw error;
    return { kind: "validation", message: error.message };
  }
}

function attemptsFor(
  request: ObserveOpenShellInferenceRouteRequest,
  options: CliOpenShellInferenceRouteObserverOptions,
): string[][] {
  const attempts = [argsFor(request.target)];
  if (
    options.allowLegacySelectedFallback === true &&
    request.target.kind === "named" &&
    request.target.gatewayName === BASE_GATEWAY_NAME
  ) {
    attempts.push(argsFor({ kind: "selected" }));
  }
  return attempts;
}

function observeCapturedRoute(
  result: CapturedOpenShellInferenceRouteResult,
): OpenShellInferenceRouteResult {
  const error = routeError(result);
  return error ? failure(error) : parseRoute(successfulOutput(result));
}

function processStartFailure(): OpenShellInferenceRouteResult {
  return failure({
    kind: "transport",
    reason: "process_start",
    message: "OpenShell could not start the inference route observation.",
  });
}

function initialFailure(): OpenShellInferenceRouteResult {
  return failure({
    kind: "command",
    reason: "indeterminate",
    message: "OpenShell inference route observation did not run.",
  });
}

function captureOptions(request: ObserveOpenShellInferenceRouteRequest) {
  return {
    ignoreError: true as const,
    includeStderr: true as const,
    includeStreams: true as const,
    maxBuffer: CAPTURE_MAX_BYTES,
    timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** Create the synchronous CLI implementation for typed inference route observations. */
export function createSynchronousCliOpenShellInferenceRouteObserver(
  capture: CaptureOpenShellInferenceRouteSynchronously,
  options: CliOpenShellInferenceRouteObserverOptions = {},
): OpenShellSynchronousInferenceRouteObserver {
  return {
    observeInferenceRoute(request) {
      const requestError = validateRequest(request, options.environment ?? process.env);
      if (requestError) return failure(requestError);
      let last = initialFailure();
      for (const args of attemptsFor(request, options)) {
        try {
          last = observeCapturedRoute(capture(args, captureOptions(request)));
        } catch {
          last = processStartFailure();
        }
        if (last.ok) return last;
      }
      return last;
    },
  };
}

/** Create the CLI implementation for typed inference route observations. */
export function createCliOpenShellInferenceRouteObserver(
  capture: CaptureOpenShellInferenceRoute,
  options: CliOpenShellInferenceRouteObserverOptions = {},
): OpenShellInferenceRouteObserver {
  return {
    async observeInferenceRoute(request) {
      const requestError = validateRequest(request, options.environment ?? process.env);
      if (requestError) return failure(requestError);
      let last = initialFailure();
      for (const args of attemptsFor(request, options)) {
        let result: CapturedOpenShellInferenceRouteResult;
        try {
          result = await capture(args, captureOptions(request));
        } catch {
          last = processStartFailure();
          continue;
        }
        last = observeCapturedRoute(result);
        if (last.ok) return last;
      }
      return last;
    },
  };
}
