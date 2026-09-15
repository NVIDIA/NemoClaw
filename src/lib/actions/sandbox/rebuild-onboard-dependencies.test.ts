// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { detectGpuWithRuntimeProviderProofForRebuild } from "./rebuild-onboard-dependencies";

describe("rebuild onboarding GPU dependency", () => {
  it("returns the provider-bound GPU observation", () => {
    const gpu = {
      type: "nvidia",
      name: "NVIDIA test GPU",
      count: 1,
      totalMemoryMB: 24_576,
      perGpuMB: 24_576,
      nimCapable: true,
      platform: "linux",
      containerGpuProof: { providerId: "docker", passed: true },
    } as const;
    const detectGpuWithRuntimeProviderProofForProvider = vi.fn(() => gpu);

    expect(
      detectGpuWithRuntimeProviderProofForRebuild("docker", () => ({
        detectGpuWithRuntimeProviderProofForProvider,
      })),
    ).toBe(gpu);
    expect(detectGpuWithRuntimeProviderProofForProvider).toHaveBeenCalledExactlyOnceWith("docker");
  });

  it("preserves the null fallback when lazy runtime preflight fails", () => {
    const loadRuntimePreflight = vi.fn((): never => {
      throw new Error("runtime preflight unavailable");
    });

    expect(detectGpuWithRuntimeProviderProofForRebuild("podman", loadRuntimePreflight)).toBeNull();
  });

  it("rejects proof from a provider other than the recorded sandbox provider", () => {
    const detectGpuWithRuntimeProviderProofForProvider = vi.fn(() => ({
      type: "nvidia" as const,
      name: "NVIDIA test GPU",
      count: 1,
      totalMemoryMB: 24_576,
      perGpuMB: 24_576,
      nimCapable: true,
      platform: "linux" as const,
      containerGpuProof: { providerId: "podman", passed: true },
    }));

    expect(
      detectGpuWithRuntimeProviderProofForRebuild("docker", () => ({
        detectGpuWithRuntimeProviderProofForProvider,
      })),
    ).toBeNull();
  });
});
