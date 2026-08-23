// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  describeOllamaModelCapacity,
  effectiveGpuMemoryMB,
  findOllamaModelEntry,
  fittableOllamaModelTags,
  largestFittableOllamaModelTag,
  modelFitsAvailableMemory,
  OLLAMA_DOWNLOAD_SIZE_FALLBACK_BYTES,
  OLLAMA_MODEL_REGISTRY,
  SMALLEST_OLLAMA_MODEL_TAG,
} from "./ollama-model-registry";

describe("OLLAMA_MODEL_REGISTRY", () => {
  it.each(
    OLLAMA_MODEL_REGISTRY.slice(0, -1).map((entry, index) => ({
      entry,
      next: OLLAMA_MODEL_REGISTRY[index + 1],
    })),
  )("orders $entry.tag before the smaller $next.tag model", ({ entry, next }) => {
    expect(entry.requiredMemoryMB).toBeGreaterThan(next.requiredMemoryMB);
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

describe("describeOllamaModelCapacity", () => {
  it("returns registry size and required memory for a known fitting tag", () => {
    const entry = OLLAMA_MODEL_REGISTRY[OLLAMA_MODEL_REGISTRY.length - 1];
    const facts = describeOllamaModelCapacity(entry.tag, {
      type: "nvidia",
      totalMemoryMB: 131_072,
      availableMemoryMB: 131_072,
    });
    expect(facts.downloadSizeBytes).toBe(entry.downloadSizeBytes);
    expect(facts.requiredMemoryMB).toBe(entry.requiredMemoryMB);
    expect(facts.fits).toBe(true);
  });

  it("marks a known tag that exceeds available memory as not fitting", () => {
    const entry = OLLAMA_MODEL_REGISTRY[0];
    const facts = describeOllamaModelCapacity(entry.tag, {
      type: "nvidia",
      totalMemoryMB: 8_000,
      availableMemoryMB: 8_000,
    });
    expect(facts.requiredMemoryMB).toBe(entry.requiredMemoryMB);
    expect(facts.fits).toBe(false);
  });

  it("reports memory fit separately from compute eligibility", () => {
    const gpu = {
      type: "nvidia",
      totalMemoryMB: 65_536,
      availableMemoryMB: 60_000,
      computeConstrained: true,
    };

    expect(describeOllamaModelCapacity("qwen3.6:35b", gpu).fits).toBe(true);
    expect(modelFitsAvailableMemory("qwen3.6:35b", gpu)).toBe(false);
  });

  it("returns all-null facts for an unknown tag", () => {
    const facts = describeOllamaModelCapacity("definitely-not-a-real-model:99b", {
      type: "nvidia",
      totalMemoryMB: 131_072,
      availableMemoryMB: 131_072,
    });
    expect(facts).toEqual({ requiredMemoryMB: null, downloadSizeBytes: null, fits: null });
  });

  it("leaves fits null when host memory is unknown", () => {
    const facts = describeOllamaModelCapacity(SMALLEST_OLLAMA_MODEL_TAG, null);
    expect(facts.downloadSizeBytes).not.toBeNull();
    expect(facts.fits).toBeNull();
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
  const abundantMemoryTags = fittableOllamaModelTags({
    type: "nvidia",
    totalMemoryMB: 131_072,
    availableMemoryMB: 131_072,
  });

  it("returns the smallest tag for null gpus and ambiguous device types", () => {
    expect(fittableOllamaModelTags(null)).toEqual([SMALLEST_OLLAMA_MODEL_TAG]);
    expect(fittableOllamaModelTags({ type: "generic", totalMemoryMB: 131_072 })).toEqual([
      SMALLEST_OLLAMA_MODEL_TAG,
    ]);
  });

  it("includes every entry that fits the available-memory figure, smallest first", () => {
    expect(abundantMemoryTags[0]).toBe(SMALLEST_OLLAMA_MODEL_TAG);
    expect(abundantMemoryTags.length).toBe(OLLAMA_MODEL_REGISTRY.length);
  });

  it.each(
    abundantMemoryTags.slice(0, -1).map((tag, index) => ({
      nextTag: abundantMemoryTags[index + 1],
      tag,
    })),
  )("orders $tag before the larger $nextTag model", ({ tag, nextTag }) => {
    const entry = OLLAMA_MODEL_REGISTRY.find((candidate) => candidate.tag === tag);
    const next = OLLAMA_MODEL_REGISTRY.find((candidate) => candidate.tag === nextTag);
    expect(entry && next && entry.requiredMemoryMB <= next.requiredMemoryMB).toBe(true);
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
    expect(fittableOllamaModelTags({ type: "nvidia", totalMemoryMB: 131_072 }).length).toBe(
      OLLAMA_MODEL_REGISTRY.length,
    );
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
      modelFitsAvailableMemory("qwen3.5:9b", {
        type: "nvidia",
        totalMemoryMB: 131_072,
        availableMemoryMB: 12_000,
      }),
    ).toBe(true);
  });
});

describe("OLLAMA_DOWNLOAD_SIZE_FALLBACK_BYTES", () => {
  it.each(OLLAMA_MODEL_REGISTRY)(
    "mirrors the $tag registry download size in the fallback map",
    (entry) => {
      expect(OLLAMA_DOWNLOAD_SIZE_FALLBACK_BYTES[entry.tag]).toBe(entry.downloadSizeBytes);
    },
  );

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

describe("L4-class dGPU bootstrap fit (23 GB VRAM)", () => {
  // NVIDIA L4 reports ~23034 MiB. The 30B-class entry's `requiredMemoryMB`
  // budget must leave enough headroom for KV cache + activations that L4
  // is excluded from the fittable list — otherwise the wizard offers a
  // model the runner spills GPU→CPU on, with cold-load timing past the
  // probe window and dead-looping the model selection menu.
  const l4Gpu = { type: "nvidia", totalMemoryMB: 23_034, availableMemoryMB: 21_800 };

  it("excludes the 30B-class compute-intensive entry on L4", () => {
    const tags = fittableOllamaModelTags(l4Gpu);
    expect(tags).toContain(SMALLEST_OLLAMA_MODEL_TAG);
    expect(tags).not.toContain("nemotron-3-nano:30b");
    expect(tags).not.toContain("qwen3.6:35b");
  });

  it("returns the smallest tag as the largest-fittable default on L4", () => {
    expect(largestFittableOllamaModelTag(l4Gpu)).toBe(SMALLEST_OLLAMA_MODEL_TAG);
  });

  it("rejects modelFitsAvailableMemory for the 30B-class entry on L4", () => {
    expect(modelFitsAvailableMemory("nemotron-3-nano:30b", l4Gpu)).toBe(false);
    expect(modelFitsAvailableMemory("qwen3.5:9b", l4Gpu)).toBe(true);
  });
});

describe("compute-constrained iGPU filter", () => {
  // Jetson-class integrated GPUs advertise unified memory that easily covers
  // a 30B-class model's `requiredMemoryMB`, but token-generation throughput
  // is too low to clear agent-loop timeouts. `computeConstrained` excludes
  // `computeIntensive` registry entries regardless of available memory.
  const jetsonGpu = {
    type: "nvidia",
    totalMemoryMB: 65_536,
    availableMemoryMB: 60_000,
    computeConstrained: true,
  };

  it("drops compute-intensive entries even when memory ostensibly fits", () => {
    const tags = fittableOllamaModelTags(jetsonGpu);
    expect(tags).toEqual([SMALLEST_OLLAMA_MODEL_TAG]);
  });

  it("modelFitsAvailableMemory returns false for compute-intensive tags on iGPU", () => {
    expect(modelFitsAvailableMemory("nemotron-3-nano:30b", jetsonGpu)).toBe(false);
    expect(modelFitsAvailableMemory("qwen3.6:35b", jetsonGpu)).toBe(false);
  });

  it("does not gate the smallest entry on iGPU", () => {
    expect(modelFitsAvailableMemory("qwen3.5:9b", jetsonGpu)).toBe(true);
  });

  it("dGPU hosts with the same memory are not gated", () => {
    const dGpu = {
      type: "nvidia",
      totalMemoryMB: 65_536,
      availableMemoryMB: 60_000,
    };
    expect(modelFitsAvailableMemory("nemotron-3-nano:30b", dGpu)).toBe(true);
    expect(fittableOllamaModelTags(dGpu)).toContain("nemotron-3-nano:30b");
  });
});
