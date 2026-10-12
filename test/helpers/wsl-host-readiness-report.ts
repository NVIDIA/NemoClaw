// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { projectHostReadiness, type HostObservations } from "../../src/lib/readiness/host";
import type { SystemReadinessReport } from "../../src/lib/readiness/types";

export function createWslHostReadinessReport(
  proof: HostObservations["containerGpuProof"] | null = { providerId: "docker", passed: true },
  ageMs = 1000,
): SystemReadinessReport {
  const completedAt = new Date(Date.now() - ageMs).toISOString();
  return projectHostReadiness(
    {
      observedAt: completedAt,
      completedAt,
      observations: {
        platform: "linux",
        architecture: "arm64",
        isWsl: true,
        isHeadlessLikely: false,
        dockerInstalled: true,
        dockerReachable: true,
        dockerHostInvalid: false,
        runtime: "docker-desktop",
        dockerCgroupVersion: "v2",
        dockerDefaultCgroupnsMode: "private",
        dockerStorageDriver: "overlay2",
        dockerUsesContainerdSnapshotter: false,
        dockerNvidiaRuntimeAvailable: true,
        dockerCpus: 8,
        dockerMemTotalBytes: 32 * 1024 ** 3,
        isContainerRuntimeUnderProvisioned: false,
        hasNestedOverlayConflict: false,
        isUnsupportedRuntime: false,
        nodeInstalled: true,
        openshellInstalled: true,
        hasNvidiaGpu: true,
        nvidiaGpuCount: 1,
        nvidiaDriverVersion: "580.65.06",
        nvidiaGpuMemoryTotalBytes: 31232 * 1024 ** 2,
        nvidiaGpuMemoryAvailableBytes: 30613 * 1024 ** 2,
        nvidiaGpuMemoryPerDeviceBytes: 31232 * 1024 ** 2,
        hostGpuPlatform: "n1x",
        nvidiaContainerToolkitInstalled: false,
        dockerCdiSpecDirs: [],
        cdiNvidiaGpuSpecMissing: true,
        runtimeProviderId: "docker",
        runtimeProviderOwnsHostReadiness: false,
        containerGpuProof: proof ?? undefined,
        platformIdentity: {
          nvidiaPlatform: "linux",
          n1xWslGpu: true,
          n1xWslProduct: true,
          osId: "ubuntu",
          osVersionId: "24.04",
        },
      },
    },
    {
      nemoclawVersion: "0.1.0",
      sourceRevision: "a".repeat(40),
      now: () => new Date(completedAt),
    },
  );
}
