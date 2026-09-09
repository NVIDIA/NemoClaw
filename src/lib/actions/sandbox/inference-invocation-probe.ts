// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../adapters/openshell/provider-command";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { getSandboxInferenceConfig } from "../../inference/config";
import { validateInferenceResponseBody } from "../../inference/health";
import { MIN_PROBE_REPLY_TOKENS, resolveMaxTokensField } from "../../inference/max-tokens-field";
import { shellQuote } from "../../runner";
import { DCODE_MANAGED_EXEC_LAUNCHER } from "./connect-inference-route-probe";
import {
  classifySandboxCommandTransportFailure,
  type SandboxCommandTransportFailure,
} from "../../adapters/sandbox/command-transport";
import {
  executeSandboxExecCommand,
  type SandboxCommandResult,
  type SandboxExecCommandOptions,
} from "./process-recovery";
import { DCODE_AGENT_NAME } from "./rebuild-dcode-target";

export type SandboxInferenceInvocationInput = {
  sandboxName: string;
  gatewayName?: string;
  runtimeSelection?: OpenShellRuntimeSelection;
  agentName?: string | null;
  provider: string;
  model: string;
  preferredInferenceApi: string | null;
};

export type SandboxInferenceInvocationResult =
  | { ok: true }
  | { ok: false; detail: string; httpStatus: number | null };

export type SandboxInferenceInvocationDeps = {
  runOpenshell?: typeof runOpenshellProviderCommand;
  execute?: (
    sandboxName: string,
    command: string,
    timeout?: number,
    options?: SandboxExecCommandOptions,
  ) => SandboxCommandResult | null;
};

/**
 * Rebuild preflight recreates the sandbox and tolerates a slow first token.
 * Status and start run in an interactive wait and use the shorter timeout.
 */
export const REBUILD_INFERENCE_INVOCATION_TIMEOUT_MS = 100_000;
export const READINESS_INFERENCE_INVOCATION_TIMEOUT_MS = 30_000;
const INFERENCE_INVOCATION_MAX_RESPONSE_BYTES = 64 * 1024;

// curl's `--max-time` bounds the whole request (connect + transfer). It must
// sit safely inside the outer exec timeout so a slow-but-healthy endpoint is
// bounded by curl (clean exit 28) instead of being SIGTERM-killed by the outer
// timeout and collapsed into a generic "unavailable" result (#11162). The
// buffer reserves headroom for `openshell sandbox exec` spawn/attach overhead
// so curl finishes before the outer kill. Note: an operator override via
// NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS shortens only the outer exec timeout, not
// this derived budget; a genuine timeout there is still reported accurately as
// a timeout with the effective duration.
const INFERENCE_INVOCATION_CONNECT_TIMEOUT_SECONDS = 5;
const INFERENCE_INVOCATION_OUTER_TIMEOUT_BUFFER_MS = 5_000;

/**
 * Derive curl's `--max-time` (whole seconds) from the outer exec timeout so the
 * request is always bounded by curl before the outer timeout can SIGTERM the
 * subprocess. Clamped to at least 1s for a pathologically small outer timeout;
 * the unit test asserts the derived budget stays strictly below every real
 * outer timeout the callers use.
 */
export function resolveInferenceInvocationMaxTimeSeconds(timeoutMs: number): number {
  const budgetMs = timeoutMs - INFERENCE_INVOCATION_OUTER_TIMEOUT_BUFFER_MS;
  const seconds = Math.floor(budgetMs / 1000);
  return Math.max(1, seconds);
}

function buildProbeRequest(input: SandboxInferenceInvocationInput): {
  endpoint: string;
  headers: string[];
  payload: Record<string, unknown>;
} {
  const config = getSandboxInferenceConfig(
    input.model,
    input.provider,
    input.preferredInferenceApi,
  );
  if (config.inferenceApi === "anthropic-messages") {
    return {
      endpoint: "https://inference.local/v1/messages",
      headers: ["anthropic-version: 2023-06-01"],
      payload: {
        model: input.model,
        max_tokens: MIN_PROBE_REPLY_TOKENS,
        messages: [{ role: "user", content: "Reply with OK" }],
      },
    };
  }
  if (config.inferenceApi === "openai-responses" || config.inferenceApi === "responses") {
    return {
      endpoint: "https://inference.local/v1/responses",
      headers: [],
      payload: {
        model: input.model,
        input: "Reply with OK",
        max_output_tokens: MIN_PROBE_REPLY_TOKENS,
      },
    };
  }
  return {
    endpoint: "https://inference.local/v1/chat/completions",
    headers: [],
    payload: {
      model: input.model,
      [resolveMaxTokensField(input.model)]: MIN_PROBE_REPLY_TOKENS,
      messages: [{ role: "user", content: "Reply with OK" }],
      stream: false,
    },
  };
}

export function buildSandboxInferenceInvocationCommand(
  input: SandboxInferenceInvocationInput,
  timeoutMs: number = REBUILD_INFERENCE_INVOCATION_TIMEOUT_MS,
): string {
  const request = buildProbeRequest(input);
  const headerArgs = ["Content-Type: application/json", ...request.headers]
    .map((header) => `-H ${shellQuote(header)}`)
    .join(" ");
  const payload = shellQuote(JSON.stringify(request.payload));
  const endpoint = shellQuote(request.endpoint);
  const maxTimeSeconds = resolveInferenceInvocationMaxTimeSeconds(timeoutMs);
  return [
    "umask 077",
    "body=$(mktemp /tmp/nemoclaw-inference-invocation.XXXXXX) || exit 1",
    "trap 'rm -f \"$body\"' EXIT HUP INT TERM",
    `code=$(curl -sS --connect-timeout ${INFERENCE_INVOCATION_CONNECT_TIMEOUT_SECONDS} --max-time ${maxTimeSeconds} --max-filesize ${INFERENCE_INVOCATION_MAX_RESPONSE_BYTES} -o "$body" -w '%{http_code}' ${headerArgs} --data-binary ${payload} ${endpoint}) || { rc=$?; printf 'curl-error:%s\\n' "$rc"; exit "$rc"; }`,
    "printf '%s\\n' \"$code\"",
    'case "$code" in 2??) cat "$body"; exit 0 ;; *) exit 1 ;; esac',
  ].join("; ");
}

export function buildDcodeSandboxInferenceInvocationArgs(
  input: SandboxInferenceInvocationInput,
  timeoutMs: number = REBUILD_INFERENCE_INVOCATION_TIMEOUT_MS,
): string[] {
  return [
    "sandbox",
    "exec",
    "--name",
    input.sandboxName,
    ...(input.gatewayName ? ["-g", input.gatewayName] : []),
    "--no-tty",
    "--env",
    "HOME=/usr/local/lib/nemoclaw",
    "--env",
    "BASH_ENV=",
    "--env",
    "ENV=",
    "--",
    DCODE_MANAGED_EXEC_LAUNCHER,
    "/bin/sh",
    "-c",
    buildSandboxInferenceInvocationCommand(input, timeoutMs),
  ];
}

/** Describe why the transport produced no result so the probe surfaces the real reason (#11162). */
function describeInvocationTransportFailure(
  failure: SandboxCommandTransportFailure | null,
): string {
  if (failure?.kind === "timeout") {
    const seconds = failure.timeoutMs / 1000;
    const rendered = seconds >= 1 ? `${Math.round(seconds)}s` : `${failure.timeoutMs}ms`;
    return `sandbox inference invocation probe timed out after ${rendered}`;
  }
  if (failure?.kind === "error") {
    return failure.detail
      ? `sandbox inference invocation probe subprocess failed (${failure.detail})`
      : "sandbox inference invocation probe subprocess failed";
  }
  return "sandbox inference invocation probe was unavailable";
}

function executeDcodeSandboxInferenceInvocation(
  input: SandboxInferenceInvocationInput,
  deps: SandboxInferenceInvocationDeps,
  timeoutMs: number,
  onTransportFailure: (failure: SandboxCommandTransportFailure) => void,
): SandboxCommandResult | null {
  const runOpenshell = deps.runOpenshell ?? runOpenshellProviderCommand;
  try {
    const result = runOpenshell(buildDcodeSandboxInferenceInvocationArgs(input, timeoutMs), {
      ignoreError: true,
      ...(input.runtimeSelection ? { runtimeSelection: input.runtimeSelection } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    if (
      result.error ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      result.stderr.trim()
    ) {
      const failure = classifySandboxCommandTransportFailure(result, timeoutMs);
      if (failure) onTransportFailure(failure);
      return null;
    }
    return {
      status: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    onTransportFailure(
      classifySandboxCommandTransportFailure({ error }, timeoutMs) ?? { kind: "error" },
    );
    return null;
  }
}

/**
 * Send one minimal agent request over the configured gateway route from the
 * still-running sandbox. The request uses OpenShell's stored provider
 * credential through inference.local; no host credential is placed in the
 * command or its output.
 */
export function probeSandboxInferenceInvocation(
  input: SandboxInferenceInvocationInput,
  deps: SandboxInferenceInvocationDeps = {},
  timeoutMs: number = REBUILD_INFERENCE_INVOCATION_TIMEOUT_MS,
): SandboxInferenceInvocationResult {
  let result: SandboxCommandResult | null;
  let transportFailure: SandboxCommandTransportFailure | null = null;
  const onTransportFailure = (failure: SandboxCommandTransportFailure) => {
    transportFailure = failure;
  };
  if (input.agentName === DCODE_AGENT_NAME) {
    result = executeDcodeSandboxInferenceInvocation(input, deps, timeoutMs, onTransportFailure);
  } else {
    const execute = deps.execute ?? executeSandboxExecCommand;
    const execOptions: SandboxExecCommandOptions = {
      ...(input.gatewayName ? { gatewayName: input.gatewayName } : {}),
      ...(input.runtimeSelection ? { runtimeSelection: input.runtimeSelection } : {}),
      allowLocalDockerFallback: false,
      onTransportFailure,
    };
    result = execute(
      input.sandboxName,
      buildSandboxInferenceInvocationCommand(input, timeoutMs),
      timeoutMs,
      execOptions,
    );
  }
  if (!result) {
    return {
      ok: false,
      detail: describeInvocationTransportFailure(transportFailure),
      httpStatus: null,
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
    ).inferenceApi;
    if (httpStatus !== null && validateInferenceResponseBody(inferenceApi, body).ok) {
      return { ok: true };
    }
    return {
      ok: false,
      detail: "sandbox inference invocation probe returned an invalid response body",
      httpStatus,
    };
  }
  const httpStatus = result.stdout.match(/(?:^|\n)([1-5]\d\d)(?:\n|$)/)?.[1];
  if (httpStatus) {
    return {
      ok: false,
      detail: `sandbox inference invocation probe returned HTTP ${httpStatus}`,
      httpStatus: Number.parseInt(httpStatus, 10),
    };
  }
  // curl exits non-zero with `curl-error:<rc>` on stdout when the request could
  // not complete. Exit 28 is curl's own timeout; surface it as an endpoint
  // timeout instead of a generic exit code so a slow-but-healthy endpoint that
  // curl bounded is reported accurately (#11162). Only the curl exit code (never
  // response content) is read from the output here.
  const curlExit = result.stdout.match(/(?:^|\n)curl-error:(\d+)(?:\n|$)/)?.[1];
  if (curlExit === "28") {
    return {
      ok: false,
      detail: "sandbox inference invocation probe timed out waiting for the endpoint (curl exit 28)",
      httpStatus: null,
    };
  }
  return {
    ok: false,
    detail: curlExit
      ? `sandbox inference invocation probe could not complete the request (curl exit ${curlExit})`
      : `sandbox inference invocation probe exited with status ${result.status}`,
    httpStatus: null,
  };
}
