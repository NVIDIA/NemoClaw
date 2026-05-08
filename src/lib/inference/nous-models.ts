// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HERMES_PROVIDER_MODEL_OPTIONS,
  NOUS_RECOMMENDED_MODELS_URL,
} from "./config";
import { isSafeModelId } from "../validation";

const DEFAULT_FETCH_TIMEOUT_MS = 2500;

type FetchResponseLike = {
  ok: boolean;
  json: () => Promise<unknown>;
};

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<FetchResponseLike>;

type RecommendedModelEntry = {
  modelName?: unknown;
  position?: unknown;
};

export type NousRecommendedModelsPayload = {
  paidRecommendedModels?: RecommendedModelEntry[];
  freeRecommendedModels?: RecommendedModelEntry[];
};

export type HermesProviderModelOptionsParams = {
  fetchFn?: FetchLike;
  fallbackModels?: readonly string[];
  timeoutMs?: number;
  url?: string;
};

function asRecommendedEntries(value: unknown): RecommendedModelEntry[] {
  return Array.isArray(value) ? value : [];
}

function sortByPortalPosition(entries: RecommendedModelEntry[]): RecommendedModelEntry[] {
  return [...entries].sort((a, b) => {
    const left = typeof a.position === "number" ? a.position : Number.MAX_SAFE_INTEGER;
    const right = typeof b.position === "number" ? b.position : Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

export function mergeModelOptions(...groups: readonly (readonly string[])[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const model of group) {
      const candidate = String(model || "").trim();
      if (!candidate || !isSafeModelId(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      merged.push(candidate);
    }
  }
  return merged;
}

export function extractNousRecommendedModelOptions(
  payload: unknown,
  fallbackModels: readonly string[] = HERMES_PROVIDER_MODEL_OPTIONS,
): string[] {
  const source = (payload || {}) as NousRecommendedModelsPayload;
  const paidModels = sortByPortalPosition(
    asRecommendedEntries(source.paidRecommendedModels),
  ).map((entry) => String(entry.modelName || ""));
  const freeModels = sortByPortalPosition(
    asRecommendedEntries(source.freeRecommendedModels),
  ).map((entry) => String(entry.modelName || ""));
  const recommended = mergeModelOptions(paidModels, freeModels);

  if (recommended.length === 0) {
    return mergeModelOptions(fallbackModels);
  }
  return mergeModelOptions(recommended, fallbackModels);
}

export async function getHermesProviderModelOptions(
  params: HermesProviderModelOptionsParams = {},
): Promise<string[]> {
  const fallbackModels = mergeModelOptions(
    params.fallbackModels ?? HERMES_PROVIDER_MODEL_OPTIONS,
  );
  const fetchFn = params.fetchFn ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof fetchFn !== "function") {
    return fallbackModels;
  }

  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(0, params.timeoutMs)
      : DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout =
    timeoutMs > 0
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : null;

  try {
    const response = await fetchFn(params.url ?? NOUS_RECOMMENDED_MODELS_URL, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return fallbackModels;
    }
    return extractNousRecommendedModelOptions(await response.json(), fallbackModels);
  } catch {
    return fallbackModels;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
