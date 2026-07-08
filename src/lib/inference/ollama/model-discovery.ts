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

/**
 * Normalize the implicit Ollama `latest` tag for equality checks without
 * confusing registry ports for tags. This does not validate registry syntax.
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
 * (#6038). Ollama owns pull completion and registration, so NemoClaw can only
 * poll its public model list after that source boundary reports completion.
 * Keep the fallback bounded so a daemon that never registers the model cannot
 * hang onboarding. Remove it when supported Ollama versions guarantee that a
 * successful pull is immediately visible in the model list.
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
