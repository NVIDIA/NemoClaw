// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { computeCapabilityPreflight, detectVllmProfile, resolveVllmModelRuntime } from "./vllm";
import { buildVllmServeCommand, VLLM_MODELS } from "./vllm-models";
import { vllmInstallTestReadiness } from "./vllm-install.test-support";
import { resolveHostLocalVllmSelection } from "./serving/host-local-vllm-selection";

const LINUX_VLLM_RUNTIMES = [
  {
    model: "muse-glimmer-30b",
    linuxPreset: "vllm.linux-amd64-nvidia.single.muse-glimmer-30b-nvfp4-w4a4",
    sparkPreset: "vllm.dgx-spark-gb10.single.muse-glimmer-30b-nvfp4-w4a4",
    image:
      "vllm/vllm-openai@sha256:7eb4028507367e69cb0abfa213042d1814c27c1b499af45fbffec8f16d9cbc6f",
    minimumComputeCapability: 120,
    minimumGpuMemoryBytes: 96_000_000_000,
    gpuMemoryUtilization: 0.75,
  },
  {
    model: "nemotron-3.5-lightning-30b",
    linuxPreset: "vllm.linux-amd64-nvidia.single.nemotron-3.5-lightning-30b-a3b-nvfp4",
    sparkPreset: "vllm.dgx-spark-gb10.single.nemotron-3.5-lightning-30b-a3b-nvfp4",
    image:
      "vllm/vllm-openai@sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2",
    minimumComputeCapability: 90,
    minimumGpuMemoryBytes: 96_000_000_000,
    gpuMemoryUtilization: 0.75,
  },
] as const;

function sparkReadiness(memoryBytes: number | undefined) {
  const profile = detectVllmProfile({ platform: "spark" })!;
  return vllmInstallTestReadiness(profile).map(({ nodeId, report }) => ({
    nodeId,
    report: {
      ...report,
      observations: report.observations.map((observation) =>
        ["host.gpu.memory_total_bytes", "host.gpu.memory_per_device_bytes"].includes(observation.id)
          ? {
              id: observation.id,
              state: memoryBytes === undefined ? ("unknown" as const) : ("present" as const),
              value: memoryBytes,
            }
          : observation,
      ),
    },
  }));
}

describe("vLLM catalog runtime selection", () => {
  it.each([
    [60_000_000_000, "", "spark-single-64gb.v1", 32768, 1, 0.5],
    [61_614_325_760, "", "spark-single-64gb.v1", 32768, 1, 0.5],
    [61_614_325_760, "qwen3.6-35b-a3b-nvfp4", "spark-single-64gb.v1", 32768, 1, 0.5],
    [64_000_000_000, "", "spark-single.v1", 262144, 4, 0.4],
    [130_000_000_000, "", "spark-single.v1", 262144, 4, 0.4],
  ] as const)(
    "selects the Spark serving limits for %i bytes with model override '%s'",
    (memoryBytes, model, recipeSuffix, context, sequences, utilization) => {
      const result = resolveHostLocalVllmSelection(
        detectVllmProfile({ platform: "spark" })!,
        { NEMOCLAW_VLLM_MODEL: model },
        { automatic: true, readinessReports: sparkReadiness(memoryBytes) },
      );
      expect(result).toMatchObject({
        kind: "selected",
        recipeId: `vllm.qwen3-6-35b-a3b-nvfp4.${recipeSuffix}`,
      });
      const selected = result as Extract<typeof result, { kind: "selected" }>;
      const command = buildVllmServeCommand(selected.model, {});
      expect(command).toContain(`--max-model-len ${String(context)}`);
      expect(command).toContain(`--max-num-seqs ${String(sequences)}`);
      expect(command).toContain(`--gpu-memory-utilization ${String(utilization)}`);
    },
  );

  it.each([59_999_999_999, undefined])(
    "rejects managed Qwen with insufficient or unknown Spark capacity: %s",
    (memoryBytes) => {
      expect(
        resolveHostLocalVllmSelection(
          detectVllmProfile({ platform: "spark" })!,
          { NEMOCLAW_VLLM_MODEL: "qwen3.6-35b-a3b-nvfp4" },
          { automatic: true, readinessReports: sparkReadiness(memoryBytes) },
        ),
      ).toMatchObject({ kind: "rejected" });
    },
  );

  it.each(LINUX_VLLM_RUNTIMES)(
    "materializes the Linux amd64 $model runtime and enforces its GPU floor (#9673)",
    ({
      model: modelSlug,
      linuxPreset,
      image,
      minimumComputeCapability,
      minimumGpuMemoryBytes,
      gpuMemoryUtilization,
    }) => {
      const linuxProfile = detectVllmProfile({ platform: "linux", type: "nvidia" })!;
      const model = VLLM_MODELS.find(({ envValue }) => envValue === modelSlug)!;
      const resolved = resolveVllmModelRuntime(linuxProfile, model, "x64");

      expect(resolved.profile).toMatchObject({
        image,
        minComputeCapability: minimumComputeCapability,
        minGpuMemoryBytes: minimumGpuMemoryBytes,
        gpuMemoryUtilization,
        servingCatalog: { presetId: linuxPreset },
      });
      expect(
        computeCapabilityPreflight(
          model,
          [minimumComputeCapability - 1],
          resolved.profile.minComputeCapability,
        ),
      ).toMatchObject({ ok: false });
      expect(
        computeCapabilityPreflight(
          model,
          [minimumComputeCapability],
          resolved.profile.minComputeCapability,
        ),
      ).toEqual({ ok: true });
    },
  );

  it.each(LINUX_VLLM_RUNTIMES)(
    "keeps the optimized DGX Spark $model recipe ahead of the Linux baseline (#9673)",
    ({ model: modelSlug, sparkPreset }) => {
      const sparkProfile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
      const model = VLLM_MODELS.find(({ envValue }) => envValue === modelSlug)!;

      expect(
        resolveVllmModelRuntime(sparkProfile, model, "arm64").profile.servingCatalog,
      ).toMatchObject({
        presetId: sparkPreset,
      });
    },
  );

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
