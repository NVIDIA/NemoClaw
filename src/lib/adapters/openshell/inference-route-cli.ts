// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertNoOpenShellGatewayEndpointOverride,
  OpenShellGatewayEndpointOverrideError,
  scopeGatewayOpenshellArgs,
  type OpenShellGatewayEndpointEnvironment,
} from "./gateway-scope";
import {
  isValidOpenShellInferenceRoute,
  type OpenShellInferenceRouteError,
  type OpenShellInferenceRouteMutationError,
  type OpenShellInferenceRouteMutationResult,
  type OpenShellInferenceRouteMutator,
  type OpenShellInferenceRouteObservation,
  type OpenShellInferenceRouteObserver,
  type OpenShellInferenceRouteResult,
  type OpenShellSynchronousInferenceRouteObserver,
  type ObserveOpenShellInferenceRouteRequest,
  type SetOpenShellInferenceRouteRequest,
} from "./inference-route";
import type { OpenShellGatewayTarget } from "./sandbox-observer";

const CAPTURE_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MUTATION_TIMEOUT_MS = 30_000;
const DEFAULT_VERIFICATION_TIMEOUT_SECONDS = 60;
const MUTATION_VERIFICATION_GRACE_MS = 15_000;
const MAX_VERIFICATION_TIMEOUT_SECONDS = 3_600;
const MAX_PROCESS_TIMEOUT_MS = 2_147_483_647;
const MUTATION_DETAIL_LIMIT = 2_000;
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
    outputLimitBytes: number;
    timeout: number;
  },
) => Promise<CapturedOpenShellInferenceRouteResult>;

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
  environment?: OpenShellGatewayEndpointEnvironment;
}>;

export type CliOpenShellInferenceRouteMutatorOptions = Readonly<{
  environment?: OpenShellGatewayEndpointEnvironment;
  /** Redact credentials and URLs before diagnostic text crosses the adapter boundary. */
  redactDiagnostic?: (value: string) => string;
}>;

type CapturedOpenShellInferenceRouteResult = Readonly<{
  status: number | null;
  signal?: NodeJS.Signals | null;
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

function compactText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function mutationDetail(
  result: CapturedOpenShellInferenceRouteResult,
  redactDiagnostic: (value: string) => string,
): string {
  return compactText(redactDiagnostic(cleanTerminalText(commandOutput(result))))
    .slice(0, MUTATION_DETAIL_LIMIT)
    .trim();
}

function withMutationDetail(message: string, detail: string): string {
  return detail ? `${message}\nOpenShell detail: ${detail}` : message;
}

const PROVIDER_QUOTES = ["'", '"', "`"] as const;

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/u.test(value);
}

function containsNotFoundPhrase(value: string): boolean {
  const phrase = "not found";
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(phrase, offset);
    if (index === -1) return false;
    if (!isWordCharacter(value[index - 1]) && !isWordCharacter(value[index + phrase.length])) {
      return true;
    }
    offset = index + phrase.length;
  }
  return false;
}

function startsWithNotFoundPhrase(value: string): boolean {
  let remainder = value.trimStart();
  if (remainder.startsWith("was") && !isWordCharacter(remainder[3])) {
    remainder = remainder.slice(3).trimStart();
  }
  if (!remainder.startsWith("not") || isWordCharacter(remainder[3])) return false;
  remainder = remainder.slice(3).trimStart();
  return remainder.startsWith("found") && !isWordCharacter(remainder[5]);
}

function lineReportsProviderNotFound(line: string, provider: string): boolean {
  for (const quote of PROVIDER_QUOTES) {
    const quotedProvider = `${quote}${provider}${quote}`;
    let offset = 0;
    while (offset < line.length) {
      const quotedIndex = line.indexOf(quotedProvider, offset);
      if (quotedIndex === -1) break;
      const prefix = line.slice(0, quotedIndex).trimEnd();
      const providerIndex = prefix.length - "provider".length;
      if (
        providerIndex >= 0 &&
        prefix.slice(providerIndex) === "provider" &&
        !isWordCharacter(prefix[providerIndex - 1])
      ) {
        const beforeProvider = prefix.slice(0, providerIndex);
        const afterProvider = line.slice(quotedIndex + quotedProvider.length).trimStart();
        if (containsNotFoundPhrase(beforeProvider) || startsWithNotFoundPhrase(afterProvider)) {
          return true;
        }
      }
      offset = quotedIndex + quotedProvider.length;
    }
  }
  return false;
}

function reportsRequestedProviderNotFound(output: string, provider: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  return (
    normalizedProvider.length > 0 &&
    output
      .slice(0, CAPTURE_MAX_BYTES)
      .toLowerCase()
      .split("\n")
      .some((line) => lineReportsProviderNotFound(line, normalizedProvider))
  );
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
  if (effectiveStatus === 0 && !result.error) return null;
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
    if (hasInferenceSection && /^Not configured$/iu.test(trimmed)) unconfigured = true;
  }
  if (sectionCount > 1 || (unconfigured && (provider !== null || model !== null))) {
    return failure({
      kind: "schema",
      reason: "malformed_output",
      message: "OpenShell returned an unrecognized inference route observation.",
    });
  }
  if (unconfigured) return success({ state: "unconfigured" });
  if (provider && model) {
    const route = { provider, model };
    if (isValidOpenShellInferenceRoute(route)) {
      return success({ state: "configured", route });
    }
    return failure({
      kind: "schema",
      reason: "malformed_output",
      message: "OpenShell returned an unrecognized inference route observation.",
    });
  }
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

function argsFor(target: OpenShellGatewayTarget): string[] {
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

function captureOptions(request: ObserveOpenShellInferenceRouteRequest) {
  return {
    ignoreError: true as const,
    includeStderr: true as const,
    includeStreams: true as const,
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
      let captured: CapturedOpenShellInferenceRouteResult;
      try {
        captured = capture(argsFor(request.target), {
          ...captureOptions(request),
          maxBuffer: CAPTURE_MAX_BYTES,
        });
      } catch {
        return processStartFailure();
      }
      return observeCapturedRoute(captured);
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
      let captured: CapturedOpenShellInferenceRouteResult;
      try {
        captured = await capture(argsFor(request.target), {
          ...captureOptions(request),
          outputLimitBytes: CAPTURE_MAX_BYTES,
        });
      } catch {
        return processStartFailure();
      }
      return observeCapturedRoute(captured);
    },
  };
}

function mutationFailure(
  error: OpenShellInferenceRouteMutationError,
  ambiguous: boolean,
): OpenShellInferenceRouteMutationResult {
  return { ok: false, error, ambiguous };
}

function mutationRequestError(
  request: SetOpenShellInferenceRouteRequest,
  environment: OpenShellGatewayEndpointEnvironment,
): OpenShellInferenceRouteMutationError | null {
  const requiredProcessTimeoutMs =
    request.verification !== "required"
      ? 0
      : (request.verificationTimeoutSeconds ?? DEFAULT_VERIFICATION_TIMEOUT_SECONDS) * 1_000 +
        MUTATION_VERIFICATION_GRACE_MS;
  if (
    !request.target.gatewayName ||
    /[\u0000-\u001F\u007F]/u.test(request.target.gatewayName) ||
    !isValidOpenShellInferenceRoute(request.route) ||
    (request.verificationTimeoutSeconds !== undefined &&
      (!Number.isSafeInteger(request.verificationTimeoutSeconds) ||
        request.verificationTimeoutSeconds <= 0 ||
        request.verificationTimeoutSeconds > MAX_VERIFICATION_TIMEOUT_SECONDS)) ||
    (request.timeoutMs !== undefined &&
      (!Number.isSafeInteger(request.timeoutMs) ||
        request.timeoutMs <= 0 ||
        request.timeoutMs > MAX_PROCESS_TIMEOUT_MS ||
        request.timeoutMs < requiredProcessTimeoutMs))
  ) {
    return {
      kind: "validation",
      message: "Invalid OpenShell inference route mutation request.",
    };
  }
  try {
    assertNoOpenShellGatewayEndpointOverride(environment);
    return null;
  } catch (error) {
    if (!(error instanceof OpenShellGatewayEndpointOverrideError)) throw error;
    return { kind: "validation", message: error.message };
  }
}

function mutationProcessTimeoutMs(request: SetOpenShellInferenceRouteRequest): number {
  if (request.timeoutMs !== undefined) return request.timeoutMs;
  if (request.verification !== "required") {
    return DEFAULT_MUTATION_TIMEOUT_MS;
  }
  return Math.max(
    DEFAULT_MUTATION_TIMEOUT_MS,
    (request.verificationTimeoutSeconds ?? DEFAULT_VERIFICATION_TIMEOUT_SECONDS) * 1_000 +
      MUTATION_VERIFICATION_GRACE_MS,
  );
}

function mutationArgs(request: SetOpenShellInferenceRouteRequest): string[] {
  const args = ["inference", "set"];
  if (request.verification === "skip") args.push("--no-verify");
  args.push("--provider", request.route.provider, "--model", request.route.model);
  if (request.verificationTimeoutSeconds !== undefined) {
    args.push("--timeout", String(request.verificationTimeoutSeconds));
  }
  return scopeGatewayOpenshellArgs(args, request.target.gatewayName);
}

function mutationError(
  request: SetOpenShellInferenceRouteRequest,
  result: CapturedOpenShellInferenceRouteResult,
  redactDiagnostic: (value: string) => string,
): OpenShellInferenceRouteMutationResult {
  const output = cleanTerminalText(commandOutput(result));
  const detail = mutationDetail(result, redactDiagnostic);
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ENOENT" || errorCode === "EACCES") {
    return mutationFailure(
      {
        kind: "transport",
        reason: "process_start",
        message: "OpenShell could not start the inference route update.",
      },
      false,
    );
  }
  if (
    errorCode === "ETIMEDOUT" ||
    errorCode === "ECANCELED" ||
    errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    errorCode === "ENOBUFS"
  ) {
    return mutationFailure(
      {
        kind: "timeout",
        message: withMutationDetail(
          "OpenShell inference route update ended without a confirmed result.",
          detail,
        ),
      },
      true,
    );
  }
  if (result.signal) {
    return mutationFailure(
      {
        kind: "command",
        reason: "indeterminate",
        exitCode: null,
        message: withMutationDetail(
          "OpenShell inference route update ended before a result was confirmed.",
          detail,
        ),
      },
      true,
    );
  }
  if (result.status === null || result.error) {
    return mutationFailure(
      {
        kind: "command",
        reason: "indeterminate",
        exitCode: null,
        message: withMutationDetail(
          "OpenShell inference route update ended before a result was confirmed.",
          detail,
        ),
      },
      true,
    );
  }
  if (/invalid wire type|proto(?:buf)?(?: decode| schema| wire)/iu.test(output)) {
    return mutationFailure(
      {
        kind: "schema",
        message: "The OpenShell CLI and gateway inference schemas do not match.",
      },
      true,
    );
  }
  const verificationFailurePrefix =
    `failed to verify inference endpoint for provider '${request.route.provider}' ` +
    `and model '${request.route.model}' at `;
  if (
    request.verification === "required" &&
    result.status !== 0 &&
    output.includes(verificationFailurePrefix)
  ) {
    return mutationFailure(
      {
        kind: "command",
        reason: "verification_failed",
        exitCode: result.status,
        message: withMutationDetail(
          "OpenShell rejected the requested provider endpoint before persisting the inference route.",
          detail,
        ),
      },
      false,
    );
  }
  if (
    /\b(?:authentication failed|unauthorized|forbidden|permission denied|requires admin privileges|missing gateway auth token|device identity required|invalid token|expired token)\b/iu.test(
      output,
    )
  ) {
    if (request.verification === "required") {
      return mutationFailure(
        {
          kind: "command",
          reason: "indeterminate",
          exitCode: result.status === 0 ? null : result.status,
          message: withMutationDetail(
            "OpenShell inference route verification reported an authorization failure; the route state is unknown.",
            detail,
          ),
        },
        true,
      );
    }
    return mutationFailure(
      {
        kind: "authentication",
        message: withMutationDetail(
          "OpenShell could not authenticate the inference route update.",
          detail,
        ),
      },
      result.status === 0,
    );
  }
  if (/\bhandshake verification failed\b/iu.test(output)) {
    return mutationFailure(
      {
        kind: "transport",
        reason: "identity_mismatch",
        message: "The selected OpenShell gateway identity does not match the recorded identity.",
      },
      result.status === 0,
    );
  }
  if (
    /\b(?:connection reset|connection aborted|connection closed|transport error)\b/iu.test(output)
  ) {
    return mutationFailure(
      {
        kind: "transport",
        reason: "unreachable",
        message: withMutationDetail("OpenShell lost the inference route update result.", detail),
      },
      true,
    );
  }
  if (result.status !== 0 && reportsRequestedProviderNotFound(output, request.route.provider)) {
    return mutationFailure(
      {
        kind: "command",
        reason: "provider_not_found",
        exitCode: result.status,
        message: withMutationDetail(
          `OpenShell could not find provider '${request.route.provider}'.`,
          detail,
        ),
      },
      false,
    );
  }
  if (result.status === 0 && !/^\s*Error:/imu.test(output)) return { ok: true };
  const effectiveStatus = result.status === 0 ? null : result.status;
  if (effectiveStatus === null) {
    return mutationFailure(
      {
        kind: "command",
        reason: "indeterminate",
        exitCode: null,
        message: withMutationDetail(
          "OpenShell inference route update returned an inconclusive result.",
          detail,
        ),
      },
      true,
    );
  }
  if (request.verification === "required") {
    return mutationFailure(
      {
        kind: "command",
        reason: "indeterminate",
        exitCode: effectiveStatus,
        message: withMutationDetail(
          `OpenShell inference route update with verification failed with exit ${String(effectiveStatus)}; the route state is unknown.`,
          detail,
        ),
      },
      true,
    );
  }
  return mutationFailure(
    {
      kind: "command",
      reason: effectiveStatus === 2 ? "invalid_request" : "failed",
      exitCode: effectiveStatus,
      message: withMutationDetail(
        `OpenShell inference route update failed with exit ${String(effectiveStatus)}.`,
        detail,
      ),
    },
    false,
  );
}

/** Create the asynchronous CLI implementation for typed inference route updates. */
export function createCliOpenShellInferenceRouteMutator(
  capture: CaptureOpenShellInferenceRoute,
  options: CliOpenShellInferenceRouteMutatorOptions = {},
): OpenShellInferenceRouteMutator {
  return {
    async setInferenceRoute(request) {
      const requestError = mutationRequestError(request, options.environment ?? process.env);
      if (requestError) return mutationFailure(requestError, false);
      let captured: CapturedOpenShellInferenceRouteResult;
      try {
        captured = await capture(mutationArgs(request), {
          ignoreError: true,
          includeStderr: true,
          includeStreams: true,
          outputLimitBytes: CAPTURE_MAX_BYTES,
          timeout: mutationProcessTimeoutMs(request),
        });
      } catch {
        return mutationFailure(
          {
            kind: "command",
            reason: "indeterminate",
            exitCode: null,
            message: "OpenShell inference route update ended before a result was confirmed.",
          },
          true,
        );
      }
      return mutationError(request, captured, options.redactDiagnostic ?? (() => ""));
    },
  };
}
