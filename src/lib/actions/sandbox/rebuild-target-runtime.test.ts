// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detectGpu: vi.fn(),
  enforceDockerGpuPatchPreserveNetwork: vi.fn(),
  isDockerDesktopWslRuntime: vi.fn(),
  isLinuxDockerDriverGatewayEnabled: vi.fn(),
  preflightRebuildCredentials: vi.fn(),
}));

vi.mock("../../inference/nim", () => ({
  detectGpu: mocks.detectGpu,
}));

vi.mock("../../onboard/docker-driver-platform", () => ({
  isLinuxDockerDriverGatewayEnabled: mocks.isLinuxDockerDriverGatewayEnabled,
}));

vi.mock("../../onboard/docker-gpu-local-inference", () => ({
  enforceDockerGpuPatchPreserveNetwork: mocks.enforceDockerGpuPatchPreserveNetwork,
}));

vi.mock("../../onboard/docker-gpu-sandbox-create", () => ({
  isDockerDesktopWslRuntime: mocks.isDockerDesktopWslRuntime,
}));

vi.mock("./rebuild-credential-preflight", () => ({
  preflightRebuildCredentials: mocks.preflightRebuildCredentials,
}));

import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import type { RebuildTargetConfig } from "./rebuild-target-config";
import { preflightRebuildTargetRuntime } from "./rebuild-target-runtime";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const TARGET = {
  resumeConfig: {
    provider: "ollama-local",
    model: "test-model",
  },
  durableConfig: {
    webSearchConfig: null,
  },
  hermesToolGateways: [],
  credentialEnv: null,
  fromDockerfile: null,
  agentDefinition: null,
} as unknown as RebuildTargetConfig;
const ENTRY = { mcp: null } as unknown as RebuildSandboxEntry;
const RECREATE_OPTIONS = {
  sandboxGpu: "enable",
  sandboxGpuDevice: null,
  controlUiPort: 18789,
  targetGatewayPort: 8080,
} as RebuildRecreateOnboardOpts;

describe("preflightRebuildTargetRuntime GPU route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    mocks.detectGpu.mockReturnValue({
      type: "nvidia",
      name: "NVIDIA test GPU",
      count: 1,
      totalMemoryMB: 24_576,
      perGpuMB: 24_576,
      nimCapable: true,
      platform: "linux",
    });
    mocks.isLinuxDockerDriverGatewayEnabled.mockReturnValue(true);
    mocks.isDockerDesktopWslRuntime.mockReturnValue(false);
    mocks.enforceDockerGpuPatchPreserveNetwork.mockResolvedValue(false);
    mocks.preflightRebuildCredentials.mockReturnValue(true);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    vi.unstubAllEnvs();
  });

  it.each([
    { control: "auto", selectedRoute: "native" },
    { control: "fallback", selectedRoute: "native" },
    { control: "1", selectedRoute: "compatibility" },
  ] as const)("passes the $selectedRoute rebuild GPU route into network preflight (#6110)", async ({
    control,
    selectedRoute,
  }) => {
    vi.stubEnv("NEMOCLAW_DOCKER_GPU_PATCH", control);
    const log = vi.fn();
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(
      preflightRebuildTargetRuntime(TARGET, ENTRY, RECREATE_OPTIONS, log, bail, {
        skipImagePreflight: true,
      }),
    ).resolves.toEqual({
      ok: true,
      preparedImage: null,
      requiresGatewayProviderReconfigure: false,
    });

    expect(mocks.enforceDockerGpuPatchPreserveNetwork).toHaveBeenCalledOnce();
    expect(mocks.enforceDockerGpuPatchPreserveNetwork).toHaveBeenCalledWith(
      "ollama-local",
      expect.objectContaining({
        sandboxGpuEnabled: true,
        hostGpuPlatform: "linux",
        sandboxGpuDevice: null,
      }),
      {
        dockerDriverGateway: true,
        selectedRoute,
        gatewayPort: 8080,
        log,
      },
    );
    expect(bail).not.toHaveBeenCalled();
  });
});
