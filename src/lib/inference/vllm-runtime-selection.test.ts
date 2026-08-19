// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { detectVllmProfile, resolveVllmModelRuntime, resolveVllmRuntimeProfile } from "./vllm";
import { VLLM_MODELS } from "./vllm-models";

describe("vLLM catalog runtime selection", () => {
  it("resolves Muse Glimmer to the generic Linux x86_64 baseline", () => {
    const profile = detectVllmProfile({ platform: "linux", type: "nvidia" });
    const muse = VLLM_MODELS.find((model) => model.envValue === "muse-glimmer-30b");

    expect(profile).not.toBeNull();
    expect(muse).toBeDefined();
    const runtime = resolveVllmRuntimeProfile(profile!, muse!, "x64");

    expect(runtime.image).toBe(
      "vllm/vllm-openai@sha256:7eb4028507367e69cb0abfa213042d1814c27c1b499af45fbffec8f16d9cbc6f",
    );
    expect(runtime.imageDownloadSizeBytes).toBe(8_632_473_449);
    expect(runtime.minComputeCapability).toBe(120);
  });

  it("rejects Muse Glimmer when no architecture-qualified runtime exists", () => {
    const profile = detectVllmProfile({ platform: "linux", type: "nvidia" });
    const muse = VLLM_MODELS.find((model) => model.envValue === "muse-glimmer-30b");

    expect(() => resolveVllmRuntimeProfile(profile!, muse!, "arm64")).toThrow(
      /no managed vLLM runtime for Linux \+ NVIDIA GPU on arm64/u,
    );
  });

  it("resolves Nemotron 3.5 Lightning to the published Linux amd64 vLLM runtime", () => {
    const profile = detectVllmProfile({ platform: "linux", type: "nvidia" });
    const lightning = VLLM_MODELS.find((model) => model.envValue === "nemotron-3.5-lightning-30b");

    expect(profile).not.toBeNull();
    expect(lightning).toBeDefined();
    const runtime = resolveVllmRuntimeProfile(profile!, lightning!, "x64");

    expect(runtime.image).toBe(
      "vllm/vllm-openai@sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2",
    );
    expect(runtime.imageDownloadSizeBytes).toBe(9_110_652_559);
    expect(runtime.minComputeCapability).toBe(80);
  });

  it("orders a general Linux baseline before a device-specific optimized recipe", () => {
    const sparkProfile = detectVllmProfile({
      platform: "spark",
      type: "nvidia",
    })!;
    const qwen = VLLM_MODELS.find((model) => model.envValue === "qwen3.6-27b")!;
    const optimized = resolveVllmModelRuntime(sparkProfile, qwen, "arm64");

    expect(optimized.model.runtime?.catalogPresetId).toBe(
      "vllm.dgx-spark-gb10.single.qwen3-6-27b-fp8",
    );

    const linuxBaselineOnly = {
      ...qwen,
      platforms: ["linux" as const],
      runtimeVariants: qwen.runtimeVariants?.filter(
        (variant) => variant.platforms?.includes("linux") && variant.architectures?.includes("x64"),
      ),
    };
    const stationLikeX64Profile = {
      ...detectVllmProfile({ platform: "linux", type: "nvidia" })!,
      name: "Linux appliance",
      platform: "station" as const,
      architecture: "x64" as const,
    };
    const fallback = resolveVllmModelRuntime(stationLikeX64Profile, linuxBaselineOnly, "x64");

    expect(fallback.model.runtime?.catalogPresetId).toBe(
      "vllm.linux-amd64-nvidia.single.qwen3-6-27b-fp8",
    );
  });
});
