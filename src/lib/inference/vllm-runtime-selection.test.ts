// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { detectVllmProfile, resolveVllmModelRuntime } from "./vllm";
import { VLLM_MODELS } from "./vllm-models";

describe("vLLM catalog runtime selection", () => {
  it("prefers a device-specific optimized recipe over the general Linux baseline", () => {
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
