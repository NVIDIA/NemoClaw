// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unified inference health probing for both local and remote providers.
 * Delegates to probeLocalProviderHealth for vllm-local/ollama-local,
 * and performs lightweight reachability checks for remote cloud providers.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CurlProbeResult } from "../http-probe";
import { runCurlProbe } from "../http-probe";
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
  failureLabel?: "unreachable" | "unhealthy";
}

export interface ProviderHealthProbeOptions {
  runCurlProbeImpl?: (argv: string[]) => CurlProbeResult;
  model?: string | null;
  getCredentialImpl?: (envName: string) => string | null | undefined;
  isWsl?: boolean;
}

const COMPATIBLE_PROVIDERS = new Set(["compatible-endpoint", "compatible-anthropic-endpoint"]);
const NVIDIA_MANAGED_PROVIDERS = new Set(["nvidia-prod", "nvidia-nim"]);
const NVIDIA_HEALTH_CREDENTIAL_ENV = "NVIDIA_API_KEY";
const KIMI_K26_MODEL = "moonshotai/kimi-k2.6";
const KIMI_STATUS_CONNECT_TIMEOUT_SECONDS = "3";
const KIMI_STATUS_MAX_TIME_SECONDS = "5";
const KIMI_HEALTH_CURL_CONFIG_PREFIX = "nemoclaw-kimi-health-curl";

function normalizeModel(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  return trimmed || null;
}

function isKimiK26Model(model: string | null | undefined): model is string {
  return normalizeModel(model)?.toLowerCase() === KIMI_K26_MODEL;
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
    replaceCurlArgValue(argv, "--connect-timeout", KIMI_STATUS_CONNECT_TIMEOUT_SECONDS),
    "--max-time",
    KIMI_STATUS_MAX_TIME_SECONDS,
  );
}

function quoteCurlConfigValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}

function createAuthCurlConfig(headerValue: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${KIMI_HEALTH_CURL_CONFIG_PREFIX}-`));
  try {
    fs.chmodSync(dir, 0o700);
    const configPath = path.join(dir, "auth.conf");
    fs.writeFileSync(configPath, `header = "${quoteCurlConfigValue(headerValue)}"\n`, {
      mode: 0o600,
      encoding: "utf8",
    });
    return configPath;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function cleanupAuthCurlConfig(configPath: string): void {
  const dir = path.dirname(configPath);
  if (dir !== os.tmpdir() && path.basename(dir).startsWith(`${KIMI_HEALTH_CURL_CONFIG_PREFIX}-`)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function buildKimiStatusProbeCurlArgs(
  model: string,
  endpoint: string,
  configPath: string,
  isWsl?: boolean,
): string[] {
  const args = useStatusProbeTiming(
    getChatCompletionsProbeCurlArgs({
      authHeader: [],
      model,
      url: endpoint,
      isWsl,
    }),
  );
  const url = args.pop() || endpoint;
  return [...args, "--config", configPath, url];
}

/**
 * Maps remote provider names to their health-check endpoints.
 * Returns null for local providers, compatible-* providers (unknown URL),
 * and unrecognized provider names.
 */
export function getRemoteProviderHealthEndpoint(provider: string): string | null {
  switch (provider) {
    case "nvidia-prod":
    case "nvidia-nim":
      return `${BUILD_ENDPOINT_URL}/models`;
    case "openai-api":
      return "https://api.openai.com/v1/models";
    case "anthropic-prod":
      return "https://api.anthropic.com/v1/models";
    case "gemini-api":
      return "https://generativelanguage.googleapis.com/v1/models";
    default:
      return null;
  }
}

function buildRemoteProbeDetail(
  providerLabel: string,
  endpoint: string,
  reachable: boolean,
  result: CurlProbeResult,
): string {
  if (reachable) {
    return `${providerLabel} endpoint is reachable at ${endpoint}.`;
  }
  return (
    `${providerLabel} endpoint at ${endpoint} is unreachable. ` +
    `Check your network connection. (${result.message})`
  );
}

function buildKimiChatCompletionsDetail(
  providerLabel: string,
  endpoint: string,
  healthy: boolean,
  result: CurlProbeResult,
): string {
  const route = `${providerLabel} Kimi K2.6 chat-completions route`;
  if (healthy) {
    return `${route} is healthy at ${endpoint}.`;
  }
  return (
    `${route} at ${endpoint} is not healthy. ` +
    `Check your network connection or ${NVIDIA_HEALTH_CREDENTIAL_ENV}. (${result.message})`
  );
}

function probeNvidiaKimiK26Health(
  provider: string,
  model: string,
  options: ProviderHealthProbeOptions,
): ProviderHealthStatus {
  const config = getProviderSelectionConfig(provider, model);
  const providerLabel = config?.providerLabel ?? provider;
  const endpoint = `${BUILD_ENDPOINT_URL}/chat/completions`;
  let apiKey = "";
  try {
    apiKey = resolveProbeCredential(NVIDIA_HEALTH_CREDENTIAL_ENV, options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: true,
      probed: false,
      providerLabel,
      endpoint,
      detail:
        `Could not resolve ${NVIDIA_HEALTH_CREDENTIAL_ENV} for Kimi K2.6 health; ` +
        `skipping model-specific chat-completions probe. (${reason})`,
    };
  }

  if (!apiKey) {
    return {
      ok: true,
      probed: false,
      providerLabel,
      endpoint,
      detail:
        `Kimi K2.6 health requires ${NVIDIA_HEALTH_CREDENTIAL_ENV}; ` +
        "skipping model-specific chat-completions probe instead of using provider-level /models reachability.",
    };
  }

  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  let authConfigPath = "";
  try {
    authConfigPath = createAuthCurlConfig(`Authorization: Bearer ${apiKey}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: true,
      probed: false,
      providerLabel,
      endpoint,
      detail:
        `Could not prepare ${NVIDIA_HEALTH_CREDENTIAL_ENV} for Kimi K2.6 health; ` +
        `skipping model-specific chat-completions probe. (${reason})`,
    };
  }

  const result = (() => {
    try {
      return runCurlProbeImpl(
        buildKimiStatusProbeCurlArgs(model, endpoint, authConfigPath, options.isWsl),
      );
    } finally {
      cleanupAuthCurlConfig(authConfigPath);
    }
  })();
  const healthy = result.ok;

  return {
    ok: healthy,
    probed: true,
    providerLabel,
    endpoint,
    detail: buildKimiChatCompletionsDetail(providerLabel, endpoint, healthy, result),
    ...(healthy ? {} : { failureLabel: result.curlStatus === 0 ? "unhealthy" : "unreachable" }),
  };
}

/**
 * Probes a remote provider endpoint for reachability.
 * Any HTTP response (including 401/403) counts as reachable — we are
 * not authenticating, just checking that the endpoint is up.
 *
 * Returns null for local providers and unrecognized providers.
 * Returns a "not probed" status for compatible-* providers (unknown URL).
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

  if (NVIDIA_MANAGED_PROVIDERS.has(provider) && isKimiK26Model(model)) {
    return probeNvidiaKimiK26Health(provider, model, options);
  }

  const endpoint = getRemoteProviderHealthEndpoint(provider);
  if (!endpoint) {
    return null;
  }

  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  const result = runCurlProbeImpl(["-sS", "--connect-timeout", "3", "--max-time", "5", endpoint]);

  // For remote providers, curlStatus === 0 means curl connected and got an
  // HTTP response. Even a 401/403 means the endpoint is reachable.
  const reachable = result.curlStatus === 0;

  return {
    ok: reachable,
    probed: true,
    providerLabel,
    endpoint,
    detail: buildRemoteProbeDetail(providerLabel, endpoint, reachable, result),
  };
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
    runCurlProbeImpl: options.runCurlProbeImpl,
  };
  const local = probeLocalProviderHealth(provider, localOptions);
  if (local) {
    return {
      ok: local.ok,
      probed: true,
      providerLabel: local.providerLabel,
      endpoint: local.endpoint,
      detail: local.detail,
    };
  }

  return probeRemoteProviderHealth(provider, options);
}
