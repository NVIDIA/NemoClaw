// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { hasExplicitContextWindow, parsePositiveInteger } from "./ollama-runtime-context";

// 4 MiB tokens (2^22) — far above any practical model context window, so it
// rejects obviously broken daemon responses while never clipping a real one.
// Matches the Ollama auto-detect ceiling (MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW).
const MAX_AUTODETECTED_VLLM_CONTEXT_WINDOW = 4_194_304;

type ModelEntry = { id?: unknown; max_model_len?: unknown };
type ApplyOptions = { env?: NodeJS.ProcessEnv; logger?: Pick<Console, "log" | "warn"> };

export type ResolveVllmContextWindowOptions = {
  /**
   * When true, only fall back to the first entry if the response lists exactly
   * one model. Multi-model responses with no exact `id` match return null
   * instead of guessing. Use for shared OpenAI-compatible gateways (which can
   * serve many models under aliases) so an unrelated model's `max_model_len`
   * is never baked in; local vLLM keeps the permissive single-served-model
   * fallback (#6177).
   */
  strictModelMatch?: boolean;
};

/**
 * Extract the runtime context window for `modelId` from a vLLM `/v1/models`
 * response (its `max_model_len`), validated against NemoClaw's auto-detect
 * ceiling. Returns null when the response is empty/malformed or the value is
 * out of range. Pure parse — shared by onboard (applyVllmRuntimeContextWindow)
 * and `inference set` so both read the same source.
 */
export function resolveVllmContextWindowFromModels(
  modelsResponse: unknown,
  modelId: string | null | undefined,
  logger: Pick<Console, "warn"> = console,
  options: ResolveVllmContextWindowOptions = {},
): number | null {
  const data = (modelsResponse as { data?: unknown } | null | undefined)?.data;
  // Drop non-object entries defensively: a compatible endpoint's /v1/models body
  // is arbitrary JSON and may contain nulls/primitives (e.g. `{"data":[null]}`),
  // which would otherwise throw when we read `.id` and abort onboarding (#6177).
  const entries = (Array.isArray(data) ? data : []).filter(
    (candidate): candidate is ModelEntry => typeof candidate === "object" && candidate !== null,
  );
  if (entries.length === 0) return null;

  const target = String(modelId ?? "").trim();
  const exactMatch = target
    ? entries.find((candidate) => String(candidate.id ?? "").trim() === target)
    : undefined;
  let entry = exactMatch;
  if (!entry) {
    if (options.strictModelMatch && entries.length > 1) {
      logger.warn(
        `  ⚠ Endpoint /v1/models lists ${entries.length} models and none match '${target}'; ` +
          `not auto-detecting the context window. Set NEMOCLAW_CONTEXT_WINDOW to override.`,
      );
      return null;
    }
    entry = entries[0];
  }
  const rawMaxModelLen = entry?.max_model_len;
  if (
    rawMaxModelLen === undefined ||
    rawMaxModelLen === null ||
    String(rawMaxModelLen).trim() === ""
  ) {
    return null;
  }

  const contextLength = parsePositiveInteger(rawMaxModelLen);
  if (!contextLength) {
    logger.warn(
      `  ⚠ vLLM /v1/models returned a non-positive or malformed max_model_len ` +
        `(${String(rawMaxModelLen)}); ignoring it.`,
    );
    return null;
  }
  if (contextLength > MAX_AUTODETECTED_VLLM_CONTEXT_WINDOW) {
    logger.warn(
      `  ⚠ vLLM /v1/models returned max_model_len=${contextLength}, above NemoClaw's ` +
        `auto-detect ceiling (${MAX_AUTODETECTED_VLLM_CONTEXT_WINDOW}); ignoring it.`,
    );
    return null;
  }
  return contextLength;
}

export function applyVllmRuntimeContextWindow(
  modelsResponse: unknown,
  modelId: string | null | undefined,
  options: ApplyOptions = {},
): void {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;

  if (hasExplicitContextWindow(env.NEMOCLAW_CONTEXT_WINDOW)) {
    logger.log(`  ℹ Keeping configured context window: ${env.NEMOCLAW_CONTEXT_WINDOW} tokens`);
    return;
  }

  const contextLength = resolveVllmContextWindowFromModels(modelsResponse, modelId, logger);
  if (contextLength === null) return;

  const value = String(contextLength);
  env.NEMOCLAW_CONTEXT_WINDOW = value;
  logger.log(`  ✓ Using vLLM max_model_len: ${value} tokens`);
}
