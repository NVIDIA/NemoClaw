// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unified inference health probing for both local and remote providers.
 * Delegates to probeLocalProviderHealth for vllm-local/ollama-local, and
 * performs authenticated model-invocation checks for remote cloud providers
 * so a probe result actually proves the configured model is invocable
 * rather than just that the provider's endpoint is network-reachable.
 */

import { createBearerAuthConfig, createXApiKeyAuthConfig } from "../adapters/http/auth-config";
import type { CurlProbeOptions, CurlProbeResult } from "../adapters/http/probe";
import { runCurlProbe } from "../adapters/http/probe";
import { normalizeCredentialValue, resolveProviderCredential } from "../credentials/store";
import { getProviderSelectionConfig } from "./config";
import type { LocalProviderHealthProbeOptions } from "./local";
import { probeLocalProviderHealth } from "./local";
import { getChatCompletionsProbeCurlArgs } from "./onboard-probes";
import { BUILD_ENDPOINT_URL } from "./provider-models";

export interface ProviderHealthStatus {
  ok: boolean;
  probed: boolean;
  providerLabel: string;
  endpoint: string;
  detail: string;
  failureLabel?: "unreachable" | "unhealthy" | "unauthorized";
  /**
   * Short qualifier rendered as `Inference (<probeLabel>):` so multi-hop
   * health (e.g. ollama backend vs. auth proxy) surfaces in the status
   * line. Absent for providers with a single hop. (#3265)
   */
  probeLabel?: string;
  /**
   * Overrides the rendered word for a healthy/ok result (e.g. "reachable"
   * for a network-only probe that does not prove model invocability).
   * Absent producers keep the default "healthy" rendering. (#6846)
   */
  okLabel?: string;
  /**
   * Additional probes that share the same Inference rendering. Used to
   * surface the Ollama auth-proxy hop alongside the backend probe so a
   * 401/unreachable proxy doesn't get hidden behind a healthy backend. (#3265)
   */
  subprobes?: ProviderHealthStatus[];
}

export interface ProviderHealthProbeOptions {
  runCurlProbeImpl?: (argv: string[], opts?: CurlProbeOptions) => CurlProbeResult;
  model?: string | null;
  getCredentialImpl?: (envName: string) => string | null | undefined;
  isWsl?: boolean;
}

const COMPATIBLE_PROVIDERS = new Set(["compatible-endpoint", "compatible-anthropic-endpoint"]);
const NVIDIA_MANAGED_PROVIDERS = new Set(["nvidia-prod", "nvidia-nim"]);
const NVIDIA_HEALTH_CREDENTIAL_ENV = "NVIDIA_INFERENCE_API_KEY";
const HEALTH_PROBE_CONNECT_TIMEOUT_SECONDS = "3";
const HEALTH_PROBE_MAX_TIME_SECONDS = "5";
const HEALTH_CURL_CONFIG_PREFIX = "nemoclaw-health-curl";
const OPENAI_CHAT_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";
// The native Gemini REST surface (v1/models, v1beta/models) requires
// ?key=/x-goog-api-key auth and rejects a plain Bearer token. Its
// OpenAI-compatible shim at /v1beta/openai/ accepts Bearer auth and is what
// the rest of NemoClaw's onboarding probes already target (see
// onboard-probes.ts getProbeAuthMode), so the health probe uses it too
// instead of a native-REST URL that would falsely read as unauthorized.
const GEMINI_CHAT_COMPLETIONS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION_HEADER = "anthropic-version: 2023-06-01";
const HEALTH_PROBE_MAX_TOKENS = 8;
const CURL_TIMEOUT_STATUS = 28;
const NODE_SPAWN_TIMEOUT_STATUS = -110;

function normalizeModel(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  return trimmed || null;
}

function resolveProbeCredential(envName: string, options: ProviderHealthProbeOptions): string {
  const raw = options.getCredentialImpl
    ? options.getCredentialImpl(envName)
    : resolveProviderCredential(envName);
  return normalizeCredentialValue(raw);
}

function replaceCurlArgValue(argv: string[], name: string, value: string): string[] {
  const next = [...argv];
  const index = next.indexOf(name);
  if (index >= 0 && index + 1 < next.length) {
    next[index + 1] = value;
    return next;
  }
  return [name, value, ...next];
}

function useStatusProbeTiming(argv: string[]): string[] {
  return replaceCurlArgValue(
    replaceCurlArgValue(argv, "--connect-timeout", HEALTH_PROBE_CONNECT_TIMEOUT_SECONDS),
    "--max-time",
    HEALTH_PROBE_MAX_TIME_SECONDS,
  );
}

function capStatusProbeOutput(argv: string[]): string[] {
  const next = [...argv];
  const dataIndex = next.indexOf("-d");
  if (dataIndex < 0 || dataIndex + 1 >= next.length) return next;
  const payload = parseJsonRecord(next[dataIndex + 1]);
  if (!payload) return next;
  if ("max_tokens" in payload) payload.max_tokens = HEALTH_PROBE_MAX_TOKENS;
  if ("max_completion_tokens" in payload) {
    payload.max_completion_tokens = HEALTH_PROBE_MAX_TOKENS;
  }
  next[dataIndex + 1] = JSON.stringify(payload);
  return next;
}

function buildChatCompletionsStatusProbeCurlArgs(
  model: string,
  endpoint: string,
  authArgs: readonly string[],
  isWsl?: boolean,
): string[] {
  const args = capStatusProbeOutput(
    useStatusProbeTiming(
      getChatCompletionsProbeCurlArgs({
        credentialArgs: [],
        model,
        url: endpoint,
        isWsl,
      }),
    ),
  );
  const url = args.pop() || endpoint;
  return [...args, ...authArgs, url];
}

function buildAnthropicMessagesProbeCurlArgs(
  model: string,
  endpoint: string,
  authArgs: readonly string[],
): string[] {
  return [
    "-sS",
    "--connect-timeout",
    HEALTH_PROBE_CONNECT_TIMEOUT_SECONDS,
    "--max-time",
    HEALTH_PROBE_MAX_TIME_SECONDS,
    "-H",
    "Content-Type: application/json",
    "-H",
    ANTHROPIC_VERSION_HEADER,
    ...authArgs,
    "-d",
    JSON.stringify({
      model,
      max_tokens: HEALTH_PROBE_MAX_TOKENS,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    }),
    endpoint,
  ];
}

type ResponseValidation = { ok: true } | { ok: false; reason: string };

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRecord(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasProviderErrorEnvelope(payload: Record<string, unknown>): boolean {
  return (
    ("error" in payload && payload.error !== null && payload.error !== undefined) ||
    payload.type === "error"
  );
}

function isValidChatContentPart(value: unknown): boolean {
  if (!isJsonRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "refusal") return typeof value.refusal === "string";
  return false;
}

function isValidChatContent(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    (Array.isArray(value) && value.length > 0 && value.every(isValidChatContentPart))
  );
}

function isValidChatToolCall(value: unknown): boolean {
  if (!isJsonRecord(value) || value.type !== "function" || typeof value.id !== "string") {
    return false;
  }
  const fn = value.function;
  return isJsonRecord(fn) && typeof fn.name === "string" && typeof fn.arguments === "string";
}

function hasValidChatMessageFields(
  message: Record<string, unknown>,
  allowStreamingDelta: boolean,
): boolean {
  let recognizedField = false;
  for (const field of ["content", "reasoning_content", "refusal"] as const) {
    if (!(field in message)) continue;
    recognizedField = true;
    const value = message[field];
    const valid =
      field === "content" ? isValidChatContent(value) : value === null || typeof value === "string";
    if (!valid) return false;
  }
  if ("tool_calls" in message) {
    recognizedField = true;
    if (
      !Array.isArray(message.tool_calls) ||
      message.tool_calls.length === 0 ||
      !message.tool_calls.every(isValidChatToolCall)
    ) {
      return false;
    }
  }
  if (allowStreamingDelta && "role" in message) {
    recognizedField = true;
    if (message.role !== "assistant") return false;
  }
  return recognizedField;
}

function hasChatCompletionsChoice(
  payload: Record<string, unknown>,
  allowStreamingDelta: boolean,
): boolean {
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) return false;
  return payload.choices.some((choice) => {
    if (!isJsonRecord(choice)) return false;
    const message = choice.message;
    if (isJsonRecord(message)) {
      return hasValidChatMessageFields(message, false);
    }
    const delta = choice.delta;
    return allowStreamingDelta && isJsonRecord(delta) && hasValidChatMessageFields(delta, true);
  });
}

function isValidAnthropicContentBlock(value: unknown): boolean {
  if (!isJsonRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "thinking") {
    return typeof value.thinking === "string" && typeof value.signature === "string";
  }
  if (value.type === "redacted_thinking") return typeof value.data === "string";
  if (value.type === "tool_use") {
    return (
      typeof value.id === "string" && typeof value.name === "string" && isJsonRecord(value.input)
    );
  }
  return false;
}

function validateChatCompletionsResponse(body: string): ResponseValidation {
  const parsed = parseJsonRecord(body);
  if (parsed) {
    if (hasProviderErrorEnvelope(parsed)) {
      return { ok: false, reason: "provider returned an error envelope" };
    }
    return hasChatCompletionsChoice(parsed, false)
      ? { ok: true }
      : { ok: false, reason: "response was not a Chat Completions result" };
  }

  // DeepSeek V4 Pro's model-specific probe requests streaming output. Accept
  // only a stream containing at least one structured Chat Completions chunk;
  // a bare 2xx, malformed SSE, or an SSE error envelope is not health proof.
  let hasValidChunk = false;
  for (const line of body.split("\n")) {
    const match = /^data:\s*(.+)$/i.exec(line.trim());
    if (!match) continue;
    const data = match[1].trim();
    if (data === "[DONE]") continue;
    const event = parseJsonRecord(data);
    if (!event) continue;
    if (hasProviderErrorEnvelope(event)) {
      return { ok: false, reason: "provider returned an error envelope" };
    }
    if (hasChatCompletionsChoice(event, true)) hasValidChunk = true;
  }
  return hasValidChunk
    ? { ok: true }
    : { ok: false, reason: "response was not a Chat Completions result" };
}

function validateAnthropicMessagesResponse(body: string): ResponseValidation {
  const parsed = parseJsonRecord(body);
  if (!parsed) return { ok: false, reason: "response was not an Anthropic Messages result" };
  if (hasProviderErrorEnvelope(parsed)) {
    return { ok: false, reason: "provider returned an error envelope" };
  }
  if (!Array.isArray(parsed.content) || parsed.content.length === 0) {
    return { ok: false, reason: "response was not an Anthropic Messages result" };
  }
  const hasContentBlock = parsed.content.some(isValidAnthropicContentBlock);
  return hasContentBlock
    ? { ok: true }
    : { ok: false, reason: "response was not an Anthropic Messages result" };
}

function validateInvocationProbeResult(
  result: CurlProbeResult,
  validateResponse: (body: string) => ResponseValidation,
): CurlProbeResult {
  if (!result.ok) return result;
  const validation = validateResponse(result.body);
  if (validation.ok) return result;
  return {
    ok: false,
    httpStatus: result.httpStatus,
    curlStatus: result.curlStatus,
    body: result.body,
    stderr: result.stderr,
    message: `HTTP ${result.httpStatus}: ${validation.reason}`,
  };
}

function isHealthProbeTimeout(result: CurlProbeResult): boolean {
  return (
    !result.ok &&
    (result.curlStatus === CURL_TIMEOUT_STATUS || result.curlStatus === NODE_SPAWN_TIMEOUT_STATUS)
  );
}

function classifyHealthProbeFailureLabel(
  result: CurlProbeResult,
): "unreachable" | "unauthorized" | "unhealthy" {
  if (result.curlStatus !== 0) return "unreachable";
  if (result.httpStatus === 401 || result.httpStatus === 403) return "unauthorized";
  return "unhealthy";
}

function buildInvocationProbeDetail(
  providerLabel: string,
  endpoint: string,
  credentialEnv: string,
  healthy: boolean,
  result: CurlProbeResult,
): string {
  const route = `${providerLabel} model-invocation probe`;
  if (healthy) {
    return `${route} succeeded at ${endpoint}.`;
  }
  return (
    `${route} at ${endpoint} did not succeed. ` +
    `Check your network connection or ${credentialEnv}. (${result.message})`
  );
}

function missingCredentialHealthStatus(
  providerLabel: string,
  endpoint: string,
  credentialEnv: string,
): ProviderHealthStatus {
  return {
    ok: true,
    probed: false,
    providerLabel,
    endpoint,
    detail:
      `${providerLabel} health requires ${credentialEnv}; ` +
      "skipping model-invocation probe instead of reporting endpoint reachability as healthy.",
  };
}

function timedOutHealthStatus(
  providerLabel: string,
  endpoint: string,
  credentialEnv: string,
  result: CurlProbeResult,
): ProviderHealthStatus {
  return {
    ok: true,
    probed: false,
    providerLabel,
    endpoint,
    detail:
      `${providerLabel} model-invocation probe did not finish within the ` +
      `${HEALTH_PROBE_MAX_TIME_SECONDS}s status budget; model health was not verified. ` +
      `Check your network connection or ${credentialEnv}. (${result.message})`,
  };
}

function credentialErrorHealthStatus(
  providerLabel: string,
  endpoint: string,
  credentialEnv: string,
  stage: "resolve" | "prepare",
  error: unknown,
): ProviderHealthStatus {
  const reason = error instanceof Error ? error.message : String(error);
  const action = stage === "resolve" ? "resolve" : "prepare";
  return {
    ok: false,
    probed: false,
    providerLabel,
    endpoint,
    failureLabel: "unhealthy",
    detail: `Could not ${action} ${credentialEnv} for ${providerLabel} health. (${reason})`,
  };
}

/**
 * Probes a Bearer-auth, OpenAI-compatible chat-completions endpoint by
 * sending a real invocation with the configured model. Covers NVIDIA-managed
 * providers (all models, not just Kimi K2.6), OpenAI, and Gemini's
 * OpenAI-compatible surface — mechanistically identical aside from
 * credential env, endpoint, and label.
 */
function probeChatCompletionsProviderHealth(
  providerLabel: string,
  model: string,
  credentialEnv: string,
  endpoint: string,
  options: ProviderHealthProbeOptions,
): ProviderHealthStatus {
  let apiKey = "";
  try {
    apiKey = resolveProbeCredential(credentialEnv, options);
  } catch (error) {
    return credentialErrorHealthStatus(providerLabel, endpoint, credentialEnv, "resolve", error);
  }

  if (!apiKey) {
    return missingCredentialHealthStatus(providerLabel, endpoint, credentialEnv);
  }

  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  let authConfig: ReturnType<typeof createBearerAuthConfig>;
  try {
    authConfig = createBearerAuthConfig(apiKey, { prefix: HEALTH_CURL_CONFIG_PREFIX });
  } catch (error) {
    return credentialErrorHealthStatus(providerLabel, endpoint, credentialEnv, "prepare", error);
  }

  const rawResult = (() => {
    try {
      return runCurlProbeImpl(
        buildChatCompletionsStatusProbeCurlArgs(model, endpoint, authConfig.args, options.isWsl),
        { trustedConfigFiles: authConfig.trustedConfigFiles },
      );
    } finally {
      authConfig.cleanup();
    }
  })();
  if (isHealthProbeTimeout(rawResult)) {
    return timedOutHealthStatus(providerLabel, endpoint, credentialEnv, rawResult);
  }
  const result = validateInvocationProbeResult(rawResult, validateChatCompletionsResponse);
  const healthy = result.ok;

  return {
    ok: healthy,
    probed: true,
    providerLabel,
    endpoint,
    detail: buildInvocationProbeDetail(providerLabel, endpoint, credentialEnv, healthy, result),
    ...(healthy ? {} : { failureLabel: classifyHealthProbeFailureLabel(result) }),
  };
}

/**
 * Probes Anthropic's Messages API by sending a real invocation with the
 * configured model. Separate from the Bearer-auth helper above because
 * Anthropic's auth shape differs (`x-api-key` + `anthropic-version` header,
 * `/v1/messages` endpoint and payload shape).
 */
function probeAnthropicMessagesProviderHealth(
  providerLabel: string,
  model: string,
  credentialEnv: string,
  endpoint: string,
  options: ProviderHealthProbeOptions,
): ProviderHealthStatus {
  let apiKey = "";
  try {
    apiKey = resolveProbeCredential(credentialEnv, options);
  } catch (error) {
    return credentialErrorHealthStatus(providerLabel, endpoint, credentialEnv, "resolve", error);
  }

  if (!apiKey) {
    return missingCredentialHealthStatus(providerLabel, endpoint, credentialEnv);
  }

  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  let authConfig: ReturnType<typeof createXApiKeyAuthConfig>;
  try {
    authConfig = createXApiKeyAuthConfig(apiKey, { prefix: HEALTH_CURL_CONFIG_PREFIX });
  } catch (error) {
    return credentialErrorHealthStatus(providerLabel, endpoint, credentialEnv, "prepare", error);
  }

  const rawResult = (() => {
    try {
      return runCurlProbeImpl(
        buildAnthropicMessagesProbeCurlArgs(model, endpoint, authConfig.args),
        {
          trustedConfigFiles: authConfig.trustedConfigFiles,
        },
      );
    } finally {
      authConfig.cleanup();
    }
  })();
  if (isHealthProbeTimeout(rawResult)) {
    return timedOutHealthStatus(providerLabel, endpoint, credentialEnv, rawResult);
  }
  const result = validateInvocationProbeResult(rawResult, validateAnthropicMessagesResponse);
  const healthy = result.ok;

  return {
    ok: healthy,
    probed: true,
    providerLabel,
    endpoint,
    detail: buildInvocationProbeDetail(providerLabel, endpoint, credentialEnv, healthy, result),
    ...(healthy ? {} : { failureLabel: classifyHealthProbeFailureLabel(result) }),
  };
}

/**
 * Probes a remote provider by invoking its configured model through a real
 * chat-completions (or Messages, for Anthropic) request, proving the model
 * is actually invocable rather than just that the endpoint is reachable.
 *
 * Returns null for local providers and unrecognized providers. Returns a
 * "not probed" status for compatible-* providers (unknown URL). `hermes-
 * provider` and `openrouter` are intentionally not covered here: both are
 * net-new integration surface (zero health signal today, not a regression),
 * and hermes-provider's OAuth flow mints a short-lived key that a host-side
 * probe reading the ambient credential env would not observe.
 */
export function probeRemoteProviderHealth(
  provider: string,
  options: ProviderHealthProbeOptions = {},
): ProviderHealthStatus | null {
  const model = normalizeModel(options.model);
  const config = getProviderSelectionConfig(provider, model || undefined);
  const providerLabel = config?.providerLabel ?? provider;

  if (COMPATIBLE_PROVIDERS.has(provider)) {
    return {
      ok: true,
      probed: false,
      providerLabel,
      endpoint: "",
      detail: "Endpoint URL is not known; skipping reachability check.",
    };
  }

  if (!config?.model) return null;

  if (NVIDIA_MANAGED_PROVIDERS.has(provider)) {
    return probeChatCompletionsProviderHealth(
      providerLabel,
      config.model,
      NVIDIA_HEALTH_CREDENTIAL_ENV,
      `${BUILD_ENDPOINT_URL}/chat/completions`,
      options,
    );
  }

  if (provider === "openai-api") {
    return probeChatCompletionsProviderHealth(
      providerLabel,
      config.model,
      config.credentialEnv,
      OPENAI_CHAT_COMPLETIONS_ENDPOINT,
      options,
    );
  }

  if (provider === "gemini-api") {
    return probeChatCompletionsProviderHealth(
      providerLabel,
      config.model,
      config.credentialEnv,
      GEMINI_CHAT_COMPLETIONS_ENDPOINT,
      options,
    );
  }

  if (provider === "anthropic-prod") {
    return probeAnthropicMessagesProviderHealth(
      providerLabel,
      config.model,
      config.credentialEnv,
      ANTHROPIC_MESSAGES_ENDPOINT,
      options,
    );
  }

  return null;
}

/**
 * Unified provider health probe — tries local first, then remote.
 * Returns null only for completely unrecognized providers.
 */
export function probeProviderHealth(
  provider: string,
  options: ProviderHealthProbeOptions = {},
): ProviderHealthStatus | null {
  const localOptions: LocalProviderHealthProbeOptions = {
    model: options.model,
    runCurlProbeImpl: options.runCurlProbeImpl,
  };
  const local = probeLocalProviderHealth(provider, localOptions);
  if (local) {
    return localToProviderHealth(local);
  }

  return probeRemoteProviderHealth(provider, options);
}

function localToProviderHealth(
  local: import("./local").LocalProviderHealthStatus,
): ProviderHealthStatus {
  const subprobes = (local.subprobes ?? []).map(localToProviderHealth);
  return {
    ok: local.ok,
    probed: true,
    providerLabel: local.providerLabel,
    endpoint: local.endpoint,
    detail: local.detail,
    ...(local.failureLabel ? { failureLabel: local.failureLabel } : {}),
    ...(local.probeLabel ? { probeLabel: local.probeLabel } : {}),
    ...(subprobes.length > 0 ? { subprobes } : {}),
  };
}
