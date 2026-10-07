// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareRuntimeHost: vi.fn(({ environment }: { environment: NodeJS.ProcessEnv }) => ({
    sandboxHostAddress: environment.NEMOCLAW_GATEWAY_RUNTIME === "podman" ? "169.254.2.2" : null,
  })),
}));

vi.mock("./runtime-provider/selection", () => ({
  resolveConfiguredRuntimeProvider: (
    _platform: NodeJS.Platform,
    _architecture: NodeJS.Architecture,
    _environment: NodeJS.ProcessEnv,
  ) => ({
    identity: { id: "docker", displayName: "Docker" },
    gateway: {
      supported: true,
      ownsHostReadiness: false,
      observeHostRuntime: mocks.prepareRuntimeHost,
      prepareHostRuntime: mocks.prepareRuntimeHost,
    },
  }),
}));

import { resolveManagedLlamaCppSelectionForGpu } from "../inference/llama-cpp/managed-selection";
import { loadManagedInferenceCatalog } from "../inference/serving/catalog-loader";
import type { GatewayObservationSnapshot, GatewayReadinessProjection } from "../readiness/gateway";
import {
  runReadinessGatedRuntimePreflight,
  type CollectedGatewayReadiness,
} from "./fatal-runtime-preflight";
import type { HostAssessment } from "./preflight";
import { createDockerRuntimeProviderBundle } from "./runtime-provider/docker";
import { createArm64ContainerGpuProver } from "./runtime-provider/nvidia-container-proof";

function wslDockerDesktopHost(): HostAssessment {
  return {
    platform: "linux",
    isWsl: true,
    runtime: "docker-desktop",
    dockerInstalled: true,
    dockerRunning: true,
    dockerReachable: true,
    nodeInstalled: true,
    openshellInstalled: true,
    isContainerRuntimeUnderProvisioned: false,
    hasNestedOverlayConflict: false,
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: false,
    isHeadlessLikely: false,
    hasNvidiaGpu: true,
    dockerCdiSpecDirs: [],
    cdiNvidiaGpuSpecMissing: false,
    nvidiaContainerToolkitInstalled: false,
    notes: [],
  };
}

function collectedGatewayReadiness(): CollectedGatewayReadiness {
  const completedAt = new Date().toISOString();
  const projection: GatewayReadinessProjection = {
    observations: [{ id: "gateway.management.mode", state: "present", value: "nemoclaw-managed" }],
    capabilities: [
      { id: "gateway.authority.resolved", state: "present" },
      { id: "gateway.attachment.valid", state: "present" },
      { id: "gateway.reuse.ready", state: "present" },
      { id: "gateway.version.compatible", state: "present" },
      { id: "gateway.port.uncontested", state: "present" },
    ],
    findings: [],
    evidence: [],
  };
  const snapshot: GatewayObservationSnapshot = {
    observedAt: completedAt,
    completedAt,
    observations: {
      owner: {
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        supervisor: null,
        requiredCapabilities: [],
      },
      attachmentState: "not-applicable",
      reuseState: "healthy",
      driftState: "not-detected",
      portConflictState: "none",
    },
  };
  return { projection, snapshot };
}

async function withLinuxArm64<T>(operation: () => Promise<T>): Promise<T> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  Object.defineProperty(process, "arch", { ...arch, value: "arm64" });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Station GB300 readiness-gated runtime preflight", () => {
  it("carries product and GPU proof into managed selection (#12476)", async () => {
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    const captureHostCommand = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout:
          "Test PASSED\nNEMOCLAW_GPU_DEVICE=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee0, 0, NVIDIA GB300, 256703, 250000\n",
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    const provider = createDockerRuntimeProviderBundle({ captureHostCommand });
    const runCaptureImpl = vi.fn((command: readonly string[]) =>
      command[0] === "nvidia-smi" && command.some((arg) => arg.includes("name,memory.total"))
        ? "NVIDIA GB300, 256703, 250000\n"
        : "",
    );

    const result = await withLinuxArm64(() =>
      runReadinessGatedRuntimePreflight(
        {},
        {
          nonInteractive: true,
          collectGatewayReadiness: async () => collectedGatewayReadiness(),
          assessHost: wslDockerDesktopHost,
          runCaptureImpl,
          collectWslNvidiaProduct: vi.fn(() => ({ n1x: false, stationGb300: true })),
          createArm64ContainerGpuProver: () =>
            createArm64ContainerGpuProver({
              platform: "linux",
              arch: "arm64",
              resolveRuntimeProvider: () => provider,
              log: () => undefined,
            }),
          warnIfHostProxyMissesLoopback: vi.fn(),
          assertRuntimeProviderHealthy: vi.fn(),
          validateSandboxGpuPreflight: vi.fn(),
        },
      ),
    );

    expect(result.readinessReport.capabilities).toContainEqual({
      id: "host.platform.station_gb300_wsl",
      state: "present",
    });
    expect(result.readinessReport.qualifications).toContainEqual(
      expect.objectContaining({
        id: "host.platform.station_gb300_wsl",
        status: "qualified",
      }),
    );
    expect(result.gpu).toMatchObject({
      gpus: [{ name: "NVIDIA GB300", memoryMB: 256_703 }],
      stationGb300WslProduct: true,
      containerGpuProof: { providerId: "docker", passed: true },
    });

    const selection = resolveManagedLlamaCppSelectionForGpu(
      {},
      result.gpu,
      loadManagedInferenceCatalog(),
      {
        architecture: "arm64",
        assess: () => ({
          ...wslDockerDesktopHost(),
          dockerCgroupVersion: "v2",
          dockerDefaultCgroupnsMode: "private",
          dockerStorageDriver: "overlay2",
          dockerUsesContainerdSnapshotter: false,
          dockerCpus: 12,
          dockerMemTotalBytes: 64 * 1024 ** 3,
          dockerCdiSpecDirs: ["/etc/cdi"],
          cdiNvidiaGpuSpecMissing: false,
          cdiNvidiaGpuSpecStale: false,
          cdiNvidiaGpuSpecNeedsRepair: false,
          nvidiaContainerToolkitInstalled: true,
        }),
        collectPlatformIdentity: () => ({
          productName: "Virtual Machine",
          stationGb300WslProduct: result.gpu?.stationGb300WslProduct ?? null,
        }),
        detectNvidiaDriverVersion: () => "580.65.06",
      },
      {
        dockerContextIsDefault: () => true,
        runtimeProviderId: "docker",
      },
    );

    expect(selection, selection.kind === "rejected" ? selection.reason : undefined).toMatchObject({
      kind: "selected",
      selection: {
        preset: {
          metadata: {
            id: "llama-cpp.station-gb300-wsl-arm64.single.qwen3-6-35b-a3b",
          },
        },
      },
    });
  });
});
