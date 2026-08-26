// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../adapters/openshell/provider-command";
import { getSandboxInferenceConfig } from "../../inference/config";
import { validateInferenceResponseBody } from "../../inference/health";
import { MIN_PROBE_REPLY_TOKENS, resolveMaxTokensField } from "../../inference/max-tokens-field";
import { shellQuote } from "../../runner";
import { DCODE_MANAGED_EXEC_LAUNCHER } from "./connect-inference-route-probe";
import {
  executeSandboxExecCommand,
  type SandboxCommandResult,
  type SandboxExecCommandOptions,
} from "./process-recovery";
import { DCODE_AGENT_NAME } from "./rebuild-dcode-target";

export type SandboxInferenceInvocationInput = {
  sandboxName: string;
  gatewayName?: string;
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
): string {
  const request = buildProbeRequest(input);
  const headerArgs = ["Content-Type: application/json", ...request.headers]
    .map((header) => `-H ${shellQuote(header)}`)
    .join(" ");
  const payload = shellQuote(JSON.stringify(request.payload));
  const endpoint = shellQuote(request.endpoint);
  return [
    "umask 077",
    "body=$(mktemp /tmp/nemoclaw-inference-invocation.XXXXXX) || exit 1",
    "trap 'rm -f \"$body\"' EXIT HUP INT TERM",
    `code=$(curl -sS --connect-timeout 5 --max-time 90 --max-filesize ${INFERENCE_INVOCATION_MAX_RESPONSE_BYTES} -o "$body" -w '%{http_code}' ${headerArgs} --data-binary ${payload} ${endpoint}) || { rc=$?; printf 'curl-error:%s\\n' "$rc"; exit "$rc"; }`,
    "printf '%s\\n' \"$code\"",
    'case "$code" in 2??) cat "$body"; exit 0 ;; *) exit 1 ;; esac',
  ].join("; ");
}

export function buildDcodeSandboxInferenceInvocationArgs(
  input: SandboxInferenceInvocationInput,
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
    buildSandboxInferenceInvocationCommand(input),
  ];
}

function executeDcodeSandboxInferenceInvocation(
  input: SandboxInferenceInvocationInput,
  deps: SandboxInferenceInvocationDeps,
  timeoutMs: number,
): SandboxCommandResult | null {
  const runOpenshell = deps.runOpenshell ?? runOpenshellProviderCommand;
  try {
    const result = runOpenshell(buildDcodeSandboxInferenceInvocationArgs(input), {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    if (
      result.error ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      result.stderr.trim()
    ) {
      return null;
    }
    return {
      status: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch {
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
  if (input.agentName === DCODE_AGENT_NAME) {
    result = executeDcodeSandboxInferenceInvocation(input, deps, timeoutMs);
  } else {
    const execute = deps.execute ?? executeSandboxExecCommand;
    const execOptions: SandboxExecCommandOptions = input.gatewayName
      ? { gatewayName: input.gatewayName, allowLocalDockerFallback: false }
      : {};
    result = execute(
      input.sandboxName,
      buildSandboxInferenceInvocationCommand(input),
      timeoutMs,
      execOptions,
    );
  }
  if (!result) {
    return {
      ok: false,
      detail: "sandbox inference invocation probe was unavailable",
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
  return {
    ok: false,
    detail: httpStatus
      ? `sandbox inference invocation probe returned HTTP ${httpStatus}`
      : `sandbox inference invocation probe exited with status ${result.status}`,
    httpStatus: httpStatus ? Number.parseInt(httpStatus, 10) : null,
  };
}
