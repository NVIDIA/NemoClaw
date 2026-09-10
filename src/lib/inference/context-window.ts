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

import { DEFAULT_CONTEXT_WINDOW } from "./config";
import {
  createOllamaApiCaptureEx,
  getLocalProviderHealthEndpoint,
  getManagedVllmProviderBinding,
  getOllamaProbeCommand,
  probeVllmModels,
  type RunCaptureExFn,
  type RunCaptureFn,
  resolveOllamaRuntimeContextWindow,
} from "./local";
import { resolveVllmContextWindowFromModels } from "./vllm-runtime-context";

export interface ContextWindowDeps {
  /** Load the model and wait for the load to finish, so the probe finds it resident. */
  loadOllamaModel: (model: string) => void;
  /**
   * Probe the running Ollama model's context length; null when unavailable.
   * `/api/ps` reports the window the daemon serves. The model's declared
   * maximum is not a substitute: the served window is capped by
   * `OLLAMA_CONTEXT_LENGTH` host-side, so adopting the declared value would
   * report a window the daemon truncates.
   */
  probeOllamaContextWindow: (model: string) => number | null;
  /** Read the running vLLM server's max_model_len for the model; null when unavailable. */
  probeVllmContextWindow: (model: string) => number | null;
  /** Fallback window for providers without a per-model runtime signal (cloud). */
  defaultCloudContextWindow: () => number;
}

const defaultContextWindowDeps: ContextWindowDeps = {
  loadOllamaModel: (model: string): void => {
    // Lazy require: ../runner is CJS and a top-level require fails to resolve
    // under the test runner. Runs only for the real (non-injected) deps.
    const { runCaptureEx } = require("../runner") as { runCaptureEx: RunCaptureExFn };
    const captureEx = createOllamaApiCaptureEx(runCaptureEx);
    console.log(`  Priming Ollama model: ${model}`);
    // Blocking probe, the command onboarding also waits for. A backgrounded
    // warm-up returns before the daemon has the model resident, and `/api/ps`
    // then reports nothing to read the served window from. Cold-loading a large
    // model can exceed the 120 s default on unified-memory and tight-VRAM
    // hosts, so retry once at 300 s as onboarding does.
    // A connection-refused result keeps `timedOut` false and skips the retry.
    if (captureEx(getOllamaProbeCommand(model)).timedOut) {
      captureEx(getOllamaProbeCommand(model, 300));
    }
  },
  // currentContextWindow = null → always probe (we recompute on every switch
  // rather than honoring an unverifiable "user pinned it" guard).
  probeOllamaContextWindow: (model: string): number | null =>
    resolveOllamaRuntimeContextWindow(model, null),
  probeVllmContextWindow: (model: string): number | null => {
    // Same source onboard uses: GET /v1/models on the host vLLM server and read
    // max_model_len (handles both NemoClaw-launched and bring-your-own vLLM).
    let managedBinding: ReturnType<typeof getManagedVllmProviderBinding>;
    try {
      managedBinding = getManagedVllmProviderBinding();
    } catch {
      return null;
    }
    let raw: string;
    if (managedBinding) {
      const result = probeVllmModels(managedBinding.baseUrl, managedBinding.apiKey);
      raw = result.ok ? result.body : "";
    } else {
      const { runCapture } = require("../runner") as { runCapture: RunCaptureFn };
      const endpoint = getLocalProviderHealthEndpoint("vllm-local");
      if (!endpoint) return null;
      raw = runCapture(["curl", "-sf", endpoint], { ignoreError: true });
    }
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
 * - ollama-local: load the model, wait for the load to finish, then probe its
 *   runtime context length. `/api/ps` lists loaded models only, so the probe
 *   returns null if the load has not finished.
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
    deps.loadOllamaModel(model);
    return deps.probeOllamaContextWindow(model);
  }
  if (provider === "vllm-local") {
    return deps.probeVllmContextWindow(model);
  }
  return deps.defaultCloudContextWindow();
}
