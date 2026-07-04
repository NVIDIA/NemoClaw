// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandboxInferenceConfig } from "../../inference/config";
import { shellQuote } from "../../runner";
import { executeSandboxExecCommand, type SandboxCommandResult } from "./process-recovery";

export type RebuildInferencePreflightInput = {
  sandboxName: string;
  provider: string;
  model: string;
  preferredInferenceApi: string | null;
};

export type RebuildInferencePreflightResult = { ok: true } | { ok: false; detail: string };

export type RebuildInferencePreflightDeps = {
  execute?: (sandboxName: string, command: string, timeout?: number) => SandboxCommandResult | null;
};

function buildProbeRequest(input: RebuildInferencePreflightInput): {
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
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with OK" }],
      },
    };
  }
  if (config.inferenceApi === "openai-responses" || config.inferenceApi === "responses") {
    return {
      endpoint: "https://inference.local/v1/responses",
      headers: [],
      payload: { model: input.model, input: "Reply with OK", max_output_tokens: 8 },
    };
  }
  return {
    endpoint: "https://inference.local/v1/chat/completions",
    headers: [],
    payload: {
      model: input.model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with OK" }],
      stream: false,
    },
  };
}

export function buildRebuildInferenceProbeCommand(input: RebuildInferencePreflightInput): string {
  const request = buildProbeRequest(input);
  const headerArgs = ["Content-Type: application/json", ...request.headers]
    .map((header) => `-H ${shellQuote(header)}`)
    .join(" ");
  const payload = shellQuote(JSON.stringify(request.payload));
  const endpoint = shellQuote(request.endpoint);
  return [
    `code=$(curl -sS --connect-timeout 5 --max-time 90 -o /dev/null -w '%{http_code}' ${headerArgs} --data-binary ${payload} ${endpoint}) || { rc=$?; printf 'curl-error:%s\\n' "$rc"; exit "$rc"; }`,
    "printf '%s\\n' \"$code\"",
    'case "$code" in 2??) exit 0 ;; *) exit 1 ;; esac',
  ].join("; ");
}

/**
 * Exercise the configured gateway route from the still-running sandbox. The
 * request uses OpenShell's stored provider credential through inference.local;
 * no host credential is placed in the command or its output.
 */
export function preflightRebuildInferenceRoute(
  input: RebuildInferencePreflightInput,
  deps: RebuildInferencePreflightDeps = {},
): RebuildInferencePreflightResult {
  const execute = deps.execute ?? executeSandboxExecCommand;
  const result = execute(input.sandboxName, buildRebuildInferenceProbeCommand(input), 100_000);
  if (result?.status === 0) return { ok: true };
  if (!result) return { ok: false, detail: "existing sandbox inference probe was unavailable" };
  const httpStatus = result.stdout.match(/(?:^|\n)([1-5]\d\d)(?:\n|$)/)?.[1];
  return {
    ok: false,
    detail: httpStatus
      ? `existing sandbox inference probe returned HTTP ${httpStatus}`
      : `existing sandbox inference probe exited with status ${result.status}`,
  };
}
