// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Recompute the context window for the model an `inference set` switch targets,
 * so the in-sandbox config matches the new model instead of carrying the prior
 * model's window. onboard already does this per provider; inference set must
 * too, or a switch leaves a stale window (e.g. a 131072 cloud default kept for
 * an Ollama model whose runtime window is ~16k → silent overflow; or an Ollama
 * window kept for a cloud model → silent under-utilization).
 */

import { VLLM_PORT } from "../core/ports";
import { DEFAULT_CONTEXT_WINDOW } from "./config";
import {
  getOllamaWarmupCommand,
  type RunCaptureFn,
  resolveOllamaRuntimeContextWindow,
} from "./local";
import { resolveVllmContextWindowFromModels } from "./vllm-runtime-context";

export interface ContextWindowDeps {
  /** Load the model so the runtime probe can read its effective context length. */
  warmOllamaModel: (model: string) => void;
  /** Probe the running Ollama model's context length; null when unavailable. */
  probeOllamaContextWindow: (model: string) => number | null;
  /** Read the running vLLM server's max_model_len for the model; null when unavailable. */
  probeVllmContextWindow: (model: string) => number | null;
  /** Fallback window for providers without a per-model runtime signal (cloud). */
  defaultCloudContextWindow: () => number;
}

const defaultContextWindowDeps: ContextWindowDeps = {
  warmOllamaModel: (model: string): void => {
    // Lazy require: ../runner is CJS and a top-level require fails to resolve
    // under the test runner. Runs only for the real (non-injected) deps.
    const { runCapture } = require("../runner") as { runCapture: RunCaptureFn };
    runCapture(getOllamaWarmupCommand(model), { ignoreError: true });
  },
  // currentContextWindow = null → always probe (we recompute on every switch
  // rather than honoring an unverifiable "user pinned it" guard).
  probeOllamaContextWindow: (model: string): number | null =>
    resolveOllamaRuntimeContextWindow(model, null),
  probeVllmContextWindow: (model: string): number | null => {
    // Same source onboard uses: GET /v1/models on the host vLLM server and read
    // max_model_len (handles both NemoClaw-launched and bring-your-own vLLM).
    const { runCapture } = require("../runner") as { runCapture: RunCaptureFn };
    const raw = runCapture(["curl", "-sf", `http://127.0.0.1:${VLLM_PORT}/v1/models`], {
      ignoreError: true,
    });
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return resolveVllmContextWindowFromModels(parsed, model);
  },
  defaultCloudContextWindow: (): number => DEFAULT_CONTEXT_WINDOW,
};

/**
 * Returns the context window to write for `(provider, model)`, or null when it
 * cannot be determined (caller should keep the existing value and warn).
 *
 * - ollama-local: warm the model, then probe its runtime context length.
 * - vllm-local: read the running server's max_model_len from /v1/models (the
 *   same source onboard uses); null when the server is unreachable.
 * - cloud providers: the onboard default. Accuracy is bounded by the missing
 *   per-model cloud context metadata (tracked as a separate issue).
 */
export function resolveContextWindowForModel(
  provider: string,
  model: string,
  deps: ContextWindowDeps = defaultContextWindowDeps,
): number | null {
  if (provider === "ollama-local") {
    deps.warmOllamaModel(model);
    return deps.probeOllamaContextWindow(model);
  }
  if (provider === "vllm-local") {
    return deps.probeVllmContextWindow(model);
  }
  return deps.defaultCloudContextWindow();
}
