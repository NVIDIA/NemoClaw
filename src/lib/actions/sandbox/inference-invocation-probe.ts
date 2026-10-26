// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { managedDcodeRequiresNonemptyContent } from "../../inference/managed-dcode/identity";
import { nativeHostedAuthHeaderScript } from "../../inference/native-provider/contract";
import { NATIVE_LOCAL_AUTH_HEADER_SCRIPT } from "../../inference/native-local/agent-config";
import { NATIVE_NVIDIA_AUTH_HEADER_SCRIPT } from "../../inference/native-nvidia/contract";
import {
  hostedNativeProvider,
  customNativeCredentialEnv,
  isCustomHostedProvider,
} from "../../inference/native-provider/hosted";
import { nativeHostedAgentConfig } from "../../inference/native-provider/agent-config";
import { SandboxCommandTransportError } from "../../adapters/sandbox/command-transport";
import type {
  OpenShellSandboxBufferedCommandExecutor,
  OpenShellSandboxBufferedCommandRequest,
} from "../../adapters/openshell/sandbox-command";
import { createCliOpenShellSandboxCommandExecutor } from "../../adapters/openshell/sandbox-command-cli";
import {
  namedOpenShellGateway,
  selectedOpenShellGateway,
} from "../../adapters/openshell/sandbox-observer";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import {
  getSandboxInferenceConfig,
  normalizeNativeLocalProviderAttachment,
  type NativeLocalProviderAttachment,
} from "../../inference/config";
import {
  isNativeNvidiaProvider,
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
} from "../../inference/native-nvidia";
import { validateInferenceResponseBody } from "../../inference/health";
import {
  MIN_PROBE_REPLY_TOKENS,
  resolveMaxTokensField,
  resolveProbeReplyTokens,
} from "../../inference/max-tokens-field";
import {
  NVCF_FUNCTION_NOT_FOUND_MARKER,
  NVCF_FUNCTION_NOT_FOUND_SHELL_ERE,
  NVCF_FUNCTION_NOT_FOUND_SHELL_MATCH_ARGS,
  nvcfFunctionNotFoundMessage,
} from "../../inference/nvcf-model-access";
import { ROOT, shellQuote } from "../../runner";
import { DCODE_MANAGED_EXEC_LAUNCHER } from "./connect-inference-route-probe";
import {
  buildSandboxCommandEnvironment,
  executeSandboxExecCommand,
  type SandboxCommandResult,
  type SandboxExecCommandOptions,
} from "../../adapters/sandbox/command-transport";
import { DCODE_AGENT_NAME } from "./rebuild-dcode-target";

export type SandboxInferenceInvocationInput = {
  sandboxName: string;
  gatewayName?: string;
  runtimeSelection?: OpenShellRuntimeSelection;
  agentName?: string | null;
  provider: string;
  model: string;
  preferredInferenceApi: string | null;
  nativeProvider?: boolean;
  nativeLocalProviderAttachment?: NativeLocalProviderAttachment;
  nativeEndpointUrl?: string;
};

export type SandboxInferenceInvocationResult =
  | { ok: true }
  | { ok: false; detail: string; httpStatus: number | null; endpoint?: string; timedOut?: true };

export type SandboxInferenceInvocationDeps = {
  commandExecutor?: OpenShellSandboxBufferedCommandExecutor;
  execute?: (
    sandboxName: string,
    command: string,
    timeout?: number,
    options?: SandboxExecCommandOptions,
  ) => Promise<SandboxCommandResult | null>;
};

/**
 * Rebuild preflight recreates the sandbox and tolerates a slow first token.
 * Status and start run in an interactive wait and use the shorter timeout.
 */
export const REBUILD_INFERENCE_INVOCATION_TIMEOUT_MS = 100_000;
// The request itself permits up to 90 seconds, so readiness must also allow
// bounded process startup and cleanup rather than cancelling a valid response.
export const INFERENCE_INVOCATION_REQUEST_TIMEOUT_SECONDS = 90;
export const READINESS_INFERENCE_INVOCATION_TIMEOUT_MS = 95_000;
const INFERENCE_INVOCATION_MAX_RESPONSE_BYTES = 64 * 1024;

function nativeProbeDefinition(input: SandboxInferenceInvocationInput) {
  if (input.nativeLocalProviderAttachment) return undefined;
  if (input.nativeProvider && isCustomHostedProvider(input.provider)) {
    if (!input.nativeEndpointUrl)
      throw new Error("Custom native inference probe is missing its endpoint");
    return {
      logicalProvider: input.provider,
      endpoint: input.nativeEndpointUrl,
      credentialEnv: customNativeCredentialEnv(input.provider),
      api:
        input.preferredInferenceApi ??
        (input.provider === "compatible-anthropic-endpoint"
          ? "anthropic-messages"
          : "openai-completions"),
    };
  }
  return hostedNativeProvider(input.provider, input.nativeEndpointUrl);
}

/** Build the protocol-specific request used to verify sandbox inference. */
function buildProbeRequest(input: SandboxInferenceInvocationInput): {
  endpoint: string;
  headers: string[];
  payload: Record<string, unknown>;
} {
  const local = normalizeNativeLocalProviderAttachment(input.nativeLocalProviderAttachment);
  if (
    input.nativeLocalProviderAttachment &&
    (!local ||
      local.sandboxName !== input.sandboxName ||
      local.provider !== input.provider ||
      (input.gatewayName && local.gatewayName !== input.gatewayName))
  )
    throw new Error("Native local inference probe authority changed.");
  const config = getSandboxInferenceConfig(
    input.model,
    input.provider,
    input.preferredInferenceApi,
    input.nativeProvider ?? Boolean(local),
    local?.endpointUrl ?? input.nativeEndpointUrl ?? null,
    input.agentName,
  );
  const useNativeNvidia = input.nativeProvider === true && isNativeNvidiaProvider(input.provider);
  const hosted = nativeProbeDefinition(input);
  const nativeHosted = input.nativeProvider === true ? hosted : undefined;
  if (input.nativeProvider === true && !useNativeNvidia && !nativeHosted && !local) {
    throw new Error("Unsupported native inference probe selection");
  }
  const baseUrl = (
    useNativeNvidia
      ? NVIDIA_HOSTED_NATIVE_ENDPOINT
      : nativeHosted
        ? nativeHosted.endpoint
        : isNativeNvidiaProvider(input.provider) || hosted
          ? "https://inference.local/v1"
          : // A native local attachment is the route, whichever agent the caller names.
            (local?.endpointUrl ?? config.inferenceBaseUrl)
  ).replace(/\/+$/u, "");
  // Gemini's existing OpenAI-compatible API ends in /v1beta/openai, not /v1.
  const apiBaseUrl =
    (local || nativeHosted) && config.inferenceApi !== "anthropic-messages"
      ? baseUrl
      : baseUrl.endsWith("/v1")
        ? baseUrl
        : `${baseUrl}/v1`;
  const attributionHeaders = nativeHosted
    ? Object.entries(nativeHostedAgentConfig(input.provider, baseUrl)?.headers ?? {}).map(
        ([name, value]) => `${name}: ${value}`,
      )
    : [];
  if (config.inferenceApi === "anthropic-messages") {
    return {
      endpoint: `${apiBaseUrl}/messages`,
      headers: ["anthropic-version: 2023-06-01", ...attributionHeaders],
      payload: {
        model: input.model,
        max_tokens: MIN_PROBE_REPLY_TOKENS,
        messages: [{ role: "user", content: "Reply with OK" }],
      },
    };
  }
  if (config.inferenceApi === "openai-responses" || config.inferenceApi === "responses") {
    return {
      endpoint: `${apiBaseUrl}/responses`,
      headers: attributionHeaders,
      payload: {
        model: input.model,
        input: "Reply with OK",
        max_output_tokens: MIN_PROBE_REPLY_TOKENS,
      },
    };
  }
  return {
    endpoint: `${apiBaseUrl}/chat/completions`,
    headers: attributionHeaders,
    payload: {
      model: input.model,
      [resolveMaxTokensField(input.model)]: resolveProbeReplyTokens(input.provider, input.model),
      messages: [{ role: "user", content: "Reply with OK" }],
      // Match DCode's pinned Ultra profile: the hosted alias can otherwise
      // exhaust a short probe on reasoning and return no visible content.
      ...(input.agentName === DCODE_AGENT_NAME &&
      managedDcodeRequiresNonemptyContent(input.model, baseUrl)
        ? { chat_template_kwargs: { force_nonempty_content: true } }
        : {}),
      stream: false,
    },
  };
}

/** The endpoint this input's API family posts to, for callers that report a hop. */
export function resolveSandboxInferenceInvocationEndpoint(
  input: SandboxInferenceInvocationInput,
): string {
  return buildProbeRequest(input).endpoint;
}

export function buildSandboxInferenceInvocationCommand(
  input: SandboxInferenceInvocationInput,
): string {
  const request = buildProbeRequest(input);
  const useNativeNvidia = input.nativeProvider === true && isNativeNvidiaProvider(input.provider);
  const useNativeLocal = Boolean(
    normalizeNativeLocalProviderAttachment(input.nativeLocalProviderAttachment),
  );
  const nativeHosted = input.nativeProvider === true ? nativeProbeDefinition(input) : undefined;
  const nativeAuth = useNativeNvidia
    ? NATIVE_NVIDIA_AUTH_HEADER_SCRIPT
    : useNativeLocal
      ? NATIVE_LOCAL_AUTH_HEADER_SCRIPT
      : nativeHosted
        ? nativeHostedAuthHeaderScript(nativeHosted)
        : undefined;
  const headerArgs =
    ["Content-Type: application/json", ...request.headers]
      .map((header) => `-H ${shellQuote(header)}`)
      .join(" ") + (nativeAuth ? ' -H "$AUTH_HEADER"' : "");
  const payload = shellQuote(JSON.stringify(request.payload));
  const endpoint = shellQuote(request.endpoint);
  return [
    "umask 077",
    ...(nativeAuth ? [nativeAuth] : []),
    "body=$(mktemp /tmp/nemoclaw-inference-invocation.XXXXXX) || exit 1",
    "trap 'rm -f \"$body\"' EXIT HUP INT TERM",
    `code=$(curl -q -sS --connect-timeout 5 --max-time ${INFERENCE_INVOCATION_REQUEST_TIMEOUT_SECONDS} --max-filesize ${INFERENCE_INVOCATION_MAX_RESPONSE_BYTES} -o "$body" -w '%{http_code}' ${headerArgs} --data-binary ${payload} ${endpoint}) || { rc=$?; printf 'curl-error:%s\\n' "$rc"; exit "$rc"; }`,
    "printf '%s\\n' \"$code\"",
    // A non-2xx body never leaves the sandbox (#6195). A 404 is classified
    // here instead, so status can name the cause the onboarding probe already
    // recognises without carrying the body that proved it (#10879).
    `case "$code" in 2??) cat "$body"; exit 0 ;; 404) grep ${NVCF_FUNCTION_NOT_FOUND_SHELL_MATCH_ARGS} ${shellQuote(NVCF_FUNCTION_NOT_FOUND_SHELL_ERE)} "$body" && printf '%s\\n' ${shellQuote(NVCF_FUNCTION_NOT_FOUND_MARKER)}; exit 1 ;; *) exit 1 ;; esac`,
  ].join("; ");
}

export function buildDcodeSandboxInferenceInvocationRequest(
  input: SandboxInferenceInvocationInput,
  timeoutMilliseconds: number,
): OpenShellSandboxBufferedCommandRequest {
  const gatewayName = input.gatewayName ?? input.runtimeSelection?.gatewayName;
  return {
    sandboxName: input.sandboxName,
    target: gatewayName ? namedOpenShellGateway(gatewayName) : selectedOpenShellGateway(),
    command: [
      DCODE_MANAGED_EXEC_LAUNCHER,
      "/bin/sh",
      "-c",
      buildSandboxInferenceInvocationCommand(input),
    ],
    sandboxEnvironment: {
      BASH_ENV: "",
      ENV: "",
      HOME: "/usr/local/lib/nemoclaw",
    },
    environment: buildSandboxCommandEnvironment(input.runtimeSelection),
    tty: false,
    timeoutMilliseconds,
  };
}

async function executeDcodeSandboxInferenceInvocation(
  input: SandboxInferenceInvocationInput,
  deps: SandboxInferenceInvocationDeps,
  timeoutMs: number,
): Promise<SandboxCommandResult | null> {
  const commandExecutor =
    deps.commandExecutor ?? createCliOpenShellSandboxCommandExecutor({ hostCwd: ROOT });
  try {
    const completed = await commandExecutor.runBuffered(
      buildDcodeSandboxInferenceInvocationRequest(input, timeoutMs),
    );
    if (completed.outcome.kind !== "completed") {
      return null;
    }
    // Preserve failed curl/launcher exit codes even when they emit stderr.
    // Successful evidence still rejects startup stderr; diagnostics never echo it.
    if (completed.outcome.exitCode === 0 && completed.stderr.trim()) return null;
    return {
      status: completed.outcome.exitCode,
      stdout: completed.stdout,
      stderr: completed.stderr,
    };
  } catch {
    return null;
  }
}

/**
 * Send one minimal agent request over the configured gateway route from the
 * still-running sandbox. The request uses OpenShell's stored provider
 * credential through the attached OpenShell provider or managed route; no host
 * credential is placed in the command or its output.
 */
export async function probeSandboxInferenceInvocation(
  input: SandboxInferenceInvocationInput,
  deps: SandboxInferenceInvocationDeps = {},
  timeoutMs: number = REBUILD_INFERENCE_INVOCATION_TIMEOUT_MS,
): Promise<SandboxInferenceInvocationResult> {
  let result: SandboxCommandResult | null;
  if (input.agentName === DCODE_AGENT_NAME) {
    result = await executeDcodeSandboxInferenceInvocation(input, deps, timeoutMs);
  } else {
    const execute = deps.execute ?? executeSandboxExecCommand;
    const execOptions: SandboxExecCommandOptions = {
      ...(input.gatewayName ? { gatewayName: input.gatewayName } : {}),
      ...(input.runtimeSelection ? { runtimeSelection: input.runtimeSelection } : {}),
    };
    result = await execute(
      input.sandboxName,
      buildSandboxInferenceInvocationCommand(input),
      timeoutMs,
      execOptions,
    ).catch((error: unknown) => {
      if (!(error instanceof SandboxCommandTransportError)) throw error;
      return null;
    });
  }
  if (!result) {
    return {
      ok: false,
      detail: "sandbox inference invocation probe was unavailable",
      httpStatus: null,
      endpoint: resolveSandboxInferenceInvocationEndpoint(input),
    };
  }
  if (result.status === 0) {
    const separator = result.stdout.indexOf("\n");
    const statusText = (separator >= 0 ? result.stdout.slice(0, separator) : result.stdout).trim();
    const httpStatus = /^2\d\d$/.test(statusText) ? Number.parseInt(statusText, 10) : null;
    const body = separator >= 0 ? result.stdout.slice(separator + 1) : "";
    const inferenceApi = getSandboxInferenceConfig(
      input.model,
      input.provider,
      input.preferredInferenceApi,
      input.nativeProvider ?? Boolean(input.nativeLocalProviderAttachment),
      normalizeNativeLocalProviderAttachment(input.nativeLocalProviderAttachment)?.endpointUrl ??
        input.nativeEndpointUrl ??
        null,
      input.agentName,
    ).inferenceApi;
    if (httpStatus !== null && validateInferenceResponseBody(inferenceApi, body).ok) {
      return { ok: true };
    }
    return {
      ok: false,
      detail: "sandbox inference invocation probe returned an invalid response body",
      httpStatus,
      endpoint: resolveSandboxInferenceInvocationEndpoint(input),
    };
  }
  const httpStatus = result.stdout.match(/(?:^|\n)([1-5]\d\d)(?:\n|$)/)?.[1];
  const timedOut =
    result.status === 28 &&
    result.stdout.split("\n").some((line) => line.trim() === "curl-error:28") &&
    !httpStatus;
  // Only the fixed marker is read back, never the line that carried it, so an
  // upstream body can still not reach diagnostics (#6195).
  const nvcfFunctionNotFound = result.stdout
    .split("\n")
    .some((line) => line.trim() === NVCF_FUNCTION_NOT_FOUND_MARKER);
  const detail = timedOut
    ? "sandbox inference invocation timed out before the upstream answered"
    : httpStatus
      ? `sandbox inference invocation probe returned HTTP ${httpStatus}`
      : `sandbox inference invocation probe exited with status ${result.status}`;
  const legacyDnsFailure =
    input.nativeProvider !== true &&
    result.stdout.split("\n").some((line) => line.trim() === "curl-error:6") &&
    new URL(resolveSandboxInferenceInvocationEndpoint(input)).hostname === "inference.local";
  return {
    ok: false,
    detail:
      httpStatus === "404" && nvcfFunctionNotFound
        ? `${detail}: ${nvcfFunctionNotFoundMessage(input.model).replace(/\.$/, "")}`
        : legacyDnsFailure
          ? `${detail}. The legacy inference route could not be resolved. If that route is no longer available, recreate this sandbox to use native inference.`
          : detail,
    httpStatus: httpStatus ? Number.parseInt(httpStatus, 10) : null,
    ...(timedOut ? { timedOut: true as const } : {}),
    endpoint: resolveSandboxInferenceInvocationEndpoint(input),
  };
}
