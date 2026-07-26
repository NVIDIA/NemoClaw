// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { waitUntil } from "../../core/wait";
import { getOllamaModelOptions } from "../local";

const PULLED_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const PULLED_MODEL_DISCOVERY_ATTEMPTS = 8;

export type PulledModelDiscoveryDeps = {
  getModelOptions?: () => string[];
  now?: () => number;
  sleep?: (ms: number) => void;
};

export type PulledModelPreparationResult = { ok: true } | { ok: false; message: string };

/**
 * Normalize the implicit Ollama `latest` tag for equality checks without
 * confusing registry ports for tags. This comparison-only helper never
 * authorizes network access; `buildLocalOllamaPullUrl` separately retains the
 * allowlist boundary for the local Ollama daemon destination.
 */
export function normalizeOllamaModelRef(model: string): string {
  const ref = String(model || "").trim();
  const lastSegment = ref.slice(ref.lastIndexOf("/") + 1);
  return ref && !lastSegment.includes(":") ? `${ref}:latest` : ref;
}

/** Compare model references using Ollama's implicit `latest` tag semantics. */
export function ollamaModelRefsMatch(left: string, right: string): boolean {
  return normalizeOllamaModelRef(left) === normalizeOllamaModelRef(right);
}

/**
 * Confirm that Ollama exposes a just-pulled model before onboarding continues.
 *
 * A successful `ollama pull` can return before the daemon lists the model
 * (#6038; stabilized in #6481). Ollama owns pull completion and registration,
 * so NemoClaw can only poll its public model list after that source boundary
 * reports completion.
 * Keep the fallback bounded so a daemon that never registers the model cannot
 * hang onboarding. TODO(#6038): remove this only when NemoClaw's minimum
 * supported Ollama version guarantees, and live CI verifies, that a successful
 * pull is immediately visible through model discovery.
 */
export function waitForPulledOllamaModel(
  model: string,
  deps: PulledModelDiscoveryDeps = {},
): boolean {
  const getModelOptions = deps.getModelOptions ?? getOllamaModelOptions;
  const now = deps.now ?? Date.now;
  return waitUntil(() => getModelOptions().some((listed) => ollamaModelRefsMatch(listed, model)), {
    deadlineMs: now() + PULLED_MODEL_DISCOVERY_TIMEOUT_MS,
    initialIntervalMs: 250,
    maxIntervalMs: 2_000,
    backoffFactor: 2,
    maxAttempts: PULLED_MODEL_DISCOVERY_ATTEMPTS,
    now,
    sleep: deps.sleep,
  });
}

/** Pull a missing model and require Ollama discovery before continuing. */
export async function ensurePulledOllamaModel(
  model: string,
  installedModels: readonly string[],
  pullModel: (model: string) => Promise<boolean>,
  discoveryDeps: PulledModelDiscoveryDeps = {},
): Promise<PulledModelPreparationResult> {
  if (installedModels.some((listed) => ollamaModelRefsMatch(listed, model))) {
    return { ok: true };
  }
  console.log(`  Pulling Ollama model: ${model}`);
  if (!(await pullModel(model))) {
    return {
      ok: false,
      message:
        `Failed to pull Ollama model '${model}'. ` +
        "Check the model name and that Ollama can access the registry, then try another model.",
    };
  }
  console.log(`  Waiting for Ollama to register model: ${model}`);
  if (!waitForPulledOllamaModel(model, discoveryDeps)) {
    return {
      ok: false,
      message:
        `Ollama pull for '${model}' completed, but Ollama did not list the model afterward. ` +
        "Wait for Ollama to finish registering the model, then choose it again.",
    };
  }
  return { ok: true };
}
