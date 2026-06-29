// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory-aware Ollama bootstrap-model registry.
 *
 * Central metadata for the bootstrap-model list. Every onboard path that
 * cares about a known Ollama model — the menu, the non-interactive
 * default, the requested-model capacity guard, and the download-size
 * fallback table — reads from this single source so model facts are not
 * duplicated across the codebase.
 *
 * Each entry pairs a tag with:
 *
 * - `requiredMemoryMB`: the GPU memory the runner needs to load the model
 *   at default context, set slightly above the on-disk weight size to
 *   leave headroom for the KV cache + context tokens.
 * - `downloadSizeBytes`: the approximate compressed tarball size, used as
 *   a fallback when the live Ollama registry manifest probe fails.
 *
 * New models go here, in descending size order; the selector walks the
 * list top-down and keeps every entry whose `requiredMemoryMB` fits the
 * host's currently available memory.
 */

import type { GpuInfo } from "./local";

export interface OllamaModelEntry {
  tag: string;
  requiredMemoryMB: number;
  downloadSizeBytes: number;
  /**
   * `true` for entries whose token-generation throughput on integrated GPUs
   * (Jetson, Windows-on-ARM iGPU) is too low to be useful under agent-loop
   * timeouts even when memory ostensibly fits. Compute-constrained hosts
   * skip these entries during bootstrap-model selection regardless of the
   * `requiredMemoryMB` headroom check.
   */
  computeIntensive?: boolean;
}

// Largest first. The selector walks this list, filters by available memory,
// and reverses the result so menus render smallest-first.
export const OLLAMA_MODEL_REGISTRY: readonly OllamaModelEntry[] = [
  {
    tag: "qwen3.6:35b",
    requiredMemoryMB: 30_000,
    downloadSizeBytes: 24_000_000_000,
    computeIntensive: true,
  },
  {
    tag: "nemotron-3-nano:30b",
    requiredMemoryMB: 26_000,
    downloadSizeBytes: 19_000_000_000,
    computeIntensive: true,
  },
  { tag: "qwen3.5:9b", requiredMemoryMB: 12_000, downloadSizeBytes: 6_600_000_000 },
];

export const SMALLEST_OLLAMA_MODEL_TAG =
  OLLAMA_MODEL_REGISTRY[OLLAMA_MODEL_REGISTRY.length - 1].tag;

export function findOllamaModelEntry(tag: string): OllamaModelEntry | null {
  return OLLAMA_MODEL_REGISTRY.find((entry) => entry.tag === tag) ?? null;
}

/**
 * Effective GPU memory for capacity decisions: prefer the currently
 * available figure (from `nvidia-smi memory.free` or `MemAvailable`) and
 * fall back to total when the host could not produce a usable free-memory
 * reading. Total is a worse signal — it ignores concurrent workload
 * footprints — but keeps the pre-registry behaviour on hosts where
 * `availableMemoryMB` is missing.
 */
export function effectiveGpuMemoryMB(gpu: GpuInfo | null): number | null {
  if (!gpu) return null;
  if (typeof gpu.availableMemoryMB === "number" && gpu.availableMemoryMB > 0) {
    return gpu.availableMemoryMB;
  }
  if (typeof gpu.totalMemoryMB === "number" && gpu.totalMemoryMB > 0) {
    return gpu.totalMemoryMB;
  }
  return null;
}

/**
 * `true` when the registered tag fits the host's currently available
 * memory. Unknown tags (e.g. user-supplied `NEMOCLAW_MODEL` values that
 * the registry has never seen) and unknown memory both return `true` so
 * the caller does not refuse to proceed when we have nothing to compare
 * against — the runner's own validation is the final authority in that
 * case.
 */
export function modelFitsAvailableMemory(tag: string, gpu: GpuInfo | null): boolean {
  const entry = findOllamaModelEntry(tag);
  if (!entry) return true;
  if (entry.computeIntensive && gpu?.computeConstrained === true) return false;
  const memory = effectiveGpuMemoryMB(gpu);
  if (memory == null) return true;
  return entry.requiredMemoryMB <= memory;
}

/**
 * Bootstrap model tags the host can plausibly load right now. Always
 * includes `SMALLEST_OLLAMA_MODEL_TAG` so the menu has at least one
 * fallback even when capacity probing says nothing in the registry fits;
 * use `anyRegistryModelFits` to detect that under-spec case explicitly
 * and warn the user before we hand them a model the runner is likely to
 * reject too.
 *
 * Output is smallest-first so menu indices stay stable as registry entries
 * are added. Only confirmed-NVIDIA and Apple-Silicon devices are eligible
 * for larger entries; ambiguous device types fall back to the smallest
 * model so a partial detection does not promote a host to a 22 GB model.
 */
export function fittableOllamaModelTags(gpu: GpuInfo | null): string[] {
  const fallback = [SMALLEST_OLLAMA_MODEL_TAG];
  if (!gpu || (gpu.type !== "nvidia" && gpu.type !== "apple")) {
    return fallback;
  }
  const memory = effectiveGpuMemoryMB(gpu);
  if (memory == null) return fallback;
  const computeConstrained = gpu.computeConstrained === true;
  const fitting = OLLAMA_MODEL_REGISTRY.filter(
    (entry) =>
      entry.requiredMemoryMB <= memory &&
      entry.tag !== SMALLEST_OLLAMA_MODEL_TAG &&
      !(computeConstrained && entry.computeIntensive),
  );
  if (fitting.length === 0) return fallback;
  return [SMALLEST_OLLAMA_MODEL_TAG, ...fitting.map((entry) => entry.tag).reverse()];
}

/**
 * `true` when at least one registry entry fits the host's currently
 * available memory. Returns `true` when memory is unknown so callers do
 * not warn blind. Confirmed-eligible device types (`nvidia`, `apple`)
 * compare against the registry; ambiguous types fall through to `true`
 * for the same reason as `fittableOllamaModelTags` — we cannot tell, so
 * the runner is left to surface any real failure.
 */
export function anyRegistryModelFits(gpu: GpuInfo | null): boolean {
  if (!gpu || (gpu.type !== "nvidia" && gpu.type !== "apple")) return true;
  const memory = effectiveGpuMemoryMB(gpu);
  if (memory == null) return true;
  const computeConstrained = gpu.computeConstrained === true;
  return OLLAMA_MODEL_REGISTRY.some(
    (entry) => entry.requiredMemoryMB <= memory && !(computeConstrained && entry.computeIntensive),
  );
}

/**
 * Largest tag in the smallest-first `fittableOllamaModelTags` output. Used
 * by callers that want a single recommended default rather than the
 * whole menu.
 */
export function largestFittableOllamaModelTag(gpu: GpuInfo | null): string {
  const tags = fittableOllamaModelTags(gpu);
  return tags[tags.length - 1];
}

/**
 * Registry-derived download-size fallback table. Used by `model-size.ts`
 * when the live `https://registry.ollama.ai` manifest probe fails.
 */
export const OLLAMA_DOWNLOAD_SIZE_FALLBACK_BYTES: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(OLLAMA_MODEL_REGISTRY.map((entry) => [entry.tag, entry.downloadSizeBytes])),
);
