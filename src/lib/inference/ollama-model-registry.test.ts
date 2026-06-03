// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  effectiveGpuMemoryMB,
  findOllamaModelEntry,
  fittableOllamaModelTags,
  largestFittableOllamaModelTag,
  modelFitsAvailableMemory,
  OLLAMA_DOWNLOAD_SIZE_FALLBACK_BYTES,
  OLLAMA_MODEL_REGISTRY,
  SMALLEST_OLLAMA_MODEL_TAG,
} from "../../../dist/lib/inference/ollama-model-registry";

describe("OLLAMA_MODEL_REGISTRY", () => {
  it("is ordered largest-first by requiredMemoryMB", () => {
    for (let i = 0; i < OLLAMA_MODEL_REGISTRY.length - 1; i++) {
      expect(OLLAMA_MODEL_REGISTRY[i].requiredMemoryMB).toBeGreaterThan(
        OLLAMA_MODEL_REGISTRY[i + 1].requiredMemoryMB,
      );
    }
  });

  it("exposes the smallest tag as SMALLEST_OLLAMA_MODEL_TAG", () => {
    const lastEntry = OLLAMA_MODEL_REGISTRY[OLLAMA_MODEL_REGISTRY.length - 1];
    expect(SMALLEST_OLLAMA_MODEL_TAG).toBe(lastEntry.tag);
  });
});

describe("findOllamaModelEntry", () => {
  it("returns the registry entry by tag", () => {
    const entry = findOllamaModelEntry(SMALLEST_OLLAMA_MODEL_TAG);
    expect(entry).not.toBeNull();
    expect(entry?.tag).toBe(SMALLEST_OLLAMA_MODEL_TAG);
  });

  it("returns null for unknown tags", () => {
    expect(findOllamaModelEntry("definitely-not-a-real-model:99b")).toBeNull();
  });
});

describe("effectiveGpuMemoryMB", () => {
  it("returns null when gpu is null", () => {
    expect(effectiveGpuMemoryMB(null)).toBeNull();
  });

  it("prefers availableMemoryMB when set", () => {
    expect(
      effectiveGpuMemoryMB({ type: "nvidia", totalMemoryMB: 131_072, availableMemoryMB: 12_000 }),
    ).toBe(12_000);
  });

  it("falls back to totalMemoryMB when availableMemoryMB is absent", () => {
    expect(effectiveGpuMemoryMB({ type: "nvidia", totalMemoryMB: 32_768 })).toBe(32_768);
  });

  it("ignores zero or negative availableMemoryMB so the caller's totalMemoryMB still wins", () => {
    expect(
      effectiveGpuMemoryMB({ type: "nvidia", totalMemoryMB: 32_768, availableMemoryMB: 0 }),
    ).toBe(32_768);
  });
});

describe("fittableOllamaModelTags", () => {
  it("returns the smallest tag for null gpus and ambiguous device types", () => {
    expect(fittableOllamaModelTags(null)).toEqual([SMALLEST_OLLAMA_MODEL_TAG]);
    expect(fittableOllamaModelTags({ type: "generic", totalMemoryMB: 131_072 })).toEqual([
      SMALLEST_OLLAMA_MODEL_TAG,
    ]);
  });

  it("includes every entry that fits the available-memory figure (smallest-first)", () => {
    const tags = fittableOllamaModelTags({
      type: "nvidia",
      totalMemoryMB: 131_072,
      availableMemoryMB: 131_072,
    });
    expect(tags[0]).toBe(SMALLEST_OLLAMA_MODEL_TAG);
    expect(tags.length).toBe(OLLAMA_MODEL_REGISTRY.length);
    // Smallest-first: each subsequent entry should require at least as much
    // memory as the previous one.
    for (let i = 0; i < tags.length - 1; i++) {
      const a = OLLAMA_MODEL_REGISTRY.find((e) => e.tag === tags[i]);
      const b = OLLAMA_MODEL_REGISTRY.find((e) => e.tag === tags[i + 1]);
      expect(a && b && a.requiredMemoryMB <= b.requiredMemoryMB).toBe(true);
    }
  });

  it("falls back to the smallest tag when nothing in the registry fits available memory", () => {
    // Unified-memory host with another GPU workload eating the system
    // pool: 128 GiB total, ~12 GiB currently available. Nothing in the
    // registry requires <= 12 GiB except the smallest model.
    expect(
      fittableOllamaModelTags({
        type: "nvidia",
        totalMemoryMB: 131_072,
        availableMemoryMB: 12_000,
      }),
    ).toEqual([SMALLEST_OLLAMA_MODEL_TAG]);
  });

  it("uses totalMemoryMB when availableMemoryMB is absent so legacy detection still works", () => {
    expect(
      fittableOllamaModelTags({ type: "nvidia", totalMemoryMB: 131_072 }).length,
    ).toBe(OLLAMA_MODEL_REGISTRY.length);
  });
});

describe("modelFitsAvailableMemory", () => {
  it("returns true for unknown tags so user-supplied model names are respected", () => {
    expect(
      modelFitsAvailableMemory("definitely-not-a-real-model:99b", {
        type: "nvidia",
        totalMemoryMB: 16_384,
        availableMemoryMB: 4_000,
      }),
    ).toBe(true);
  });

  it("returns true when GPU memory is unknown so capacity gating does not fire blind", () => {
    expect(modelFitsAvailableMemory(OLLAMA_MODEL_REGISTRY[0].tag, null)).toBe(true);
  });

  it("returns false when a known model exceeds the host's currently available memory", () => {
    expect(
      modelFitsAvailableMemory("qwen3.6:35b", {
        type: "nvidia",
        totalMemoryMB: 131_072,
        availableMemoryMB: 12_000,
      }),
    ).toBe(false);
  });

  it("returns true when a known model fits", () => {
    expect(
      modelFitsAvailableMemory("qwen2.5:7b", {
        type: "nvidia",
        totalMemoryMB: 131_072,
        availableMemoryMB: 12_000,
      }),
    ).toBe(true);
  });
});

describe("OLLAMA_DOWNLOAD_SIZE_FALLBACK_BYTES", () => {
  it("mirrors the registry's downloadSizeBytes for every entry", () => {
    for (const entry of OLLAMA_MODEL_REGISTRY) {
      expect(OLLAMA_DOWNLOAD_SIZE_FALLBACK_BYTES[entry.tag]).toBe(entry.downloadSizeBytes);
    }
  });

  it("exposes the largest fittable tag via largestFittableOllamaModelTag", () => {
    expect(
      largestFittableOllamaModelTag({
        type: "nvidia",
        totalMemoryMB: 131_072,
        availableMemoryMB: 12_000,
      }),
    ).toBe(SMALLEST_OLLAMA_MODEL_TAG);
    const allFit = largestFittableOllamaModelTag({
      type: "nvidia",
      totalMemoryMB: 131_072,
      availableMemoryMB: 131_072,
    });
    expect(allFit).toBe(OLLAMA_MODEL_REGISTRY[0].tag);
  });

  it("treats apple silicon the same as nvidia when availableMemoryMB is supplied", () => {
    // The registry filter is identical across confirmed types — given the
    // same availableMemoryMB it returns the same set of fittable tags. The
    // macOS detection path populates availableMemoryMB from `vm_stat`
    // reclaimable pages; this test exercises the filter logic directly so
    // it does not depend on the macOS-only probe.
    expect(
      fittableOllamaModelTags({ type: "apple", totalMemoryMB: 131_072, availableMemoryMB: 12_000 }),
    ).toEqual([SMALLEST_OLLAMA_MODEL_TAG]);
  });
});
