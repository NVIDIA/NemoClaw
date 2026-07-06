// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createOpenAiLikeAuthConfig } from "../adapters/http/auth-config";
import { runCurlProbe } from "../adapters/http/probe";
import { getCredential } from "../credentials/store";
import { hasExplicitContextWindow } from "./ollama-runtime-context";
import { resolveVllmContextWindowFromModels } from "./vllm-runtime-context";

/** Injectable `/v1/models` fetcher; returns parsed JSON, or null when unavailable. */
export type CompatibleEndpointModelsFetcher = (
  endpointUrl: string,
  apiKey: string,
) => unknown | null;

export interface ApplyCompatibleEndpointContextWindowOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn">;
  /** Credential env used to authenticate the `/v1/models` probe. */
  credentialEnv?: string | null;
  /** Already-resolved API key; takes precedence over `credentialEnv`. */
  apiKey?: string | null;
  /** Override the default host curl fetch (unit tests inject a fake). */
  fetchModels?: CompatibleEndpointModelsFetcher;
  /** Override credential resolution (unit tests inject a fake). */
  resolveCredential?: (credentialEnv: string) => string | null | undefined;
}

/**
 * GET `<baseUrl>/models` on the host and return the parsed JSON body, or null
 * when the endpoint is unreachable, errors, or returns a non-JSON body. This is
 * the same source vLLM local onboarding reads, generalized to any configured
 * OpenAI-compatible endpoint (custom / `compatible-endpoint`). Auth is sent when
 * the endpoint requires an API key (e.g. a vLLM launched with `--api-key`).
 *
 * Security: this runs host-side during privileged onboarding, before the
 * sandbox and its OpenShell network policy exist, and targets the same endpoint
 * URL the immediately-preceding chat-completions validation probe already
 * reached — so it adds no egress surface beyond that validation. The credential
 * travels in a curl `--config` temp file (0600), never on the argv.
 */
export function fetchCompatibleEndpointModels(endpointUrl: string, apiKey: string): unknown | null {
  const baseUrl = String(endpointUrl).replace(/\/+$/, "");
  const authConfig = createOpenAiLikeAuthConfig(apiKey || "");
  try {
    const result = runCurlProbe(
      [
        "-sS",
        "--connect-timeout",
        "10",
        "--max-time",
        "15",
        ...authConfig.args,
        `${baseUrl}/models`,
      ],
      { trustedConfigFiles: authConfig.trustedConfigFiles },
    );
    if (!result.ok || !result.body) return null;
    try {
      return JSON.parse(result.body);
    } catch {
      return null;
    }
  } finally {
    authConfig.cleanup();
  }
}

// The value this probe last auto-detected. onboard can re-run provider
// selection (e.g. after a failed `inference set` the user picks a different
// endpoint/model), so a value we set on an earlier pass must not be mistaken
// for a user override on the next — otherwise a stale window from endpoint A
// would be kept for endpoint B. Mirrors the Ollama auto-state contract.
// TODO(#6177): this auto-state tracking mirrors the Ollama contract
// (autoDetectedOllamaContextWindow in ollama-runtime-context.ts). If a third
// provider adopts the same "auto-detected vs user override" pattern, extract a
// shared trackAutoDetectedContextWindow helper instead of duplicating it again.
let autoDetectedCompatibleContextWindow: string | null = null;

/** Test-only: forget any tracked auto value without touching the environment. */
export function resetCompatibleEndpointContextWindowAutoState(): void {
  autoDetectedCompatibleContextWindow = null;
}

/**
 * Drop a value this probe auto-detected on an earlier pass. onboard calls this
 * before each provider-selection pass so that when the user retries away to a
 * different provider, endpoint A's probed `max_model_len` is not left in the
 * environment where `dockerfile-patch` would bake it as if the user had set it.
 * A genuine user-supplied `NEMOCLAW_CONTEXT_WINDOW` (one this probe never wrote)
 * is preserved because it never equals the tracked auto value (#6177).
 */
export function clearAutoDetectedCompatibleContextWindow(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    autoDetectedCompatibleContextWindow &&
    env.NEMOCLAW_CONTEXT_WINDOW === autoDetectedCompatibleContextWindow
  ) {
    delete env.NEMOCLAW_CONTEXT_WINDOW;
  }
  autoDetectedCompatibleContextWindow = null;
}

/**
 * Set `NEMOCLAW_CONTEXT_WINDOW` from a configured OpenAI-compatible endpoint's
 * runtime `max_model_len` so custom / `compatible-endpoint` onboarding no longer
 * falls back to a small architecture-default context (see #6177).
 *
 * - An explicit `NEMOCLAW_CONTEXT_WINDOW` always wins and is never downgraded.
 * - A value this probe set on an earlier pass is not treated as an override; it
 *   is recomputed, or cleared when the new endpoint reports nothing usable.
 * - When the endpoint cannot be probed, warn and keep the default context.
 * - Under the unit-test runner the default curl fetch is skipped (endpoints are
 *   unreachable and curl would hang on DNS); pass `fetchModels` to exercise it.
 */
export function applyCompatibleEndpointContextWindow(
  endpointUrl: string,
  model: string | null | undefined,
  options: ApplyCompatibleEndpointContextWindowOptions = {},
): void {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;

  const currentContextWindow = env.NEMOCLAW_CONTEXT_WINDOW;
  const currentIsPreviousAuto =
    !!currentContextWindow &&
    !!autoDetectedCompatibleContextWindow &&
    currentContextWindow === autoDetectedCompatibleContextWindow;
  const userContextWindow = currentIsPreviousAuto ? null : currentContextWindow;

  const clearPreviousAuto = (): void => {
    if (currentIsPreviousAuto) {
      delete env.NEMOCLAW_CONTEXT_WINDOW;
      autoDetectedCompatibleContextWindow = null;
    }
  };

  if (hasExplicitContextWindow(userContextWindow)) {
    logger.log(`  ℹ Keeping configured context window: ${userContextWindow} tokens`);
    return;
  }

  const fetchModels = options.fetchModels;
  if (!fetchModels && env.VITEST === "true") return;

  const resolveCredential = options.resolveCredential ?? getCredential;
  const apiKey =
    options.apiKey ?? (options.credentialEnv ? resolveCredential(options.credentialEnv) : "") ?? "";

  const models = (fetchModels ?? fetchCompatibleEndpointModels)(endpointUrl, apiKey);
  if (models === null || models === undefined) {
    logger.warn(
      "  ⚠ Could not read the endpoint's /v1/models max_model_len; using the default context " +
        "window. Set NEMOCLAW_CONTEXT_WINDOW to override.",
    );
    clearPreviousAuto();
    return;
  }

  // strictModelMatch: a compatible endpoint can be a shared gateway serving many
  // models, so never guess the first entry's max_model_len for a model that is
  // not an exact /v1/models id — that would bake an unrelated model's window.
  const contextLength = resolveVllmContextWindowFromModels(models, model, logger, {
    strictModelMatch: true,
  });
  if (contextLength === null) {
    clearPreviousAuto();
    return;
  }

  const value = String(contextLength);
  env.NEMOCLAW_CONTEXT_WINDOW = value;
  autoDetectedCompatibleContextWindow = value;
  logger.log(`  ✓ Using endpoint max_model_len: ${value} tokens`);
}
