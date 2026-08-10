// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The serving-port guard on the single-node managed vLLM install (#8685).
// Focused file because vllm.test.ts sits at the per-file line budget.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerCapture: vi.fn(),
  dockerForceRm: vi.fn(),
  dockerImageInspectFormat: vi.fn(),
  dockerPullWithProgressWatchdog: vi.fn(),
  dockerRunDetached: vi.fn(),
  dockerSpawn: vi.fn(),
  dockerStop: vi.fn(),
  findUnwritableModelCachePath: vi.fn(),
  getGpuIndicesByName: vi.fn<(_pattern: RegExp) => number[]>(() => []),
  measureDirectorySizeBytes: vi.fn(),
  probeDockerStorage: vi.fn(),
  probeHostStorage: vi.fn(),
  runCapture: vi.fn(),
  tryInstallManagedClusterManagedVllm: vi.fn(async () => ({ kind: "not-selected" as const })),
}));

vi.mock("../runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner")>()),
  runCapture: mocks.runCapture,
}));

vi.mock("../adapters/docker", () => ({
  dockerCapture: mocks.dockerCapture,
  dockerForceRm: mocks.dockerForceRm,
  dockerImageInspectFormat: mocks.dockerImageInspectFormat,
  dockerPullWithProgressWatchdog: mocks.dockerPullWithProgressWatchdog,
  dockerRunDetached: mocks.dockerRunDetached,
  dockerSpawn: mocks.dockerSpawn,
  dockerStop: mocks.dockerStop,
}));

vi.mock("./nim", () => ({
  getGpuIndicesByName: mocks.getGpuIndicesByName,
}));

vi.mock("./vllm-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vllm-storage")>();
  return {
    ...actual,
    findUnwritableModelCachePath: mocks.findUnwritableModelCachePath,
    measureDirectorySizeBytes: mocks.measureDirectorySizeBytes,
    probeDockerStorage: mocks.probeDockerStorage,
    probeHostStorage: mocks.probeHostStorage,
  };
});

vi.mock("./serving/vllm-managed-support", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./serving/vllm-managed-support")>();
  return {
    ...actual,
    tryInstallManagedClusterManagedVllm: mocks.tryInstallManagedClusterManagedVllm,
  };
});

import { detectVllmProfile, installVllm } from "./vllm";
import {
  applyVllmInstallProbeDefaults,
  createVllmInstallSpies,
  mockSuccessfulVllmInstall,
  resetVllmInstallEnv,
  type VllmInstallSpies,
} from "./vllm-install.test-support";

describe("managed vLLM serving-port guard (#8685)", () => {
  const originalEnv = { ...process.env };
  let errSpy: VllmInstallSpies["errSpy"];
  let restoreSpies: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    applyVllmInstallProbeDefaults(mocks);
    mocks.getGpuIndicesByName.mockReturnValue([0]);
    mocks.tryInstallManagedClusterManagedVllm.mockResolvedValue({ kind: "not-selected" });
    ({ errSpy, restore: restoreSpies } = createVllmInstallSpies());
    resetVllmInstallEnv();
    process.env.HF_TOKEN = "hf_test";
  });

  afterEach(() => {
    restoreSpies();
    process.env = { ...originalEnv };
  });

  it("stops before the image pull when the serving port is already in use", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    const promptFn = vi.fn<(q: string) => Promise<string>>();
    const checkServingPort = vi.fn(async (port: number) => ({
      ok: false,
      reason: `lsof reports python3 (PID 4242) listening on port ${String(port)}`,
    }));

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn,
      checkServingPort,
    });

    expect(result).toEqual({ ok: false });
    expect(checkServingPort).toHaveBeenCalledWith(8000);
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    const reported = errSpy.mock.calls.flat().join("\n");
    expect(reported).toContain("port 8000 is already in use");
    expect(reported).toContain("PID 4242");
    expect(reported).not.toContain("exit 125");
  });

  it("proceeds past the guard when the serving port is free", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    const checkServingPort = vi.fn(async () => ({ ok: true }));

    await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn<(q: string) => Promise<string>>(),
      checkServingPort,
    });

    expect(checkServingPort).toHaveBeenCalledWith(8000);
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join("\n")).not.toContain("already in use");
  });

  it("leaves the install unguarded when no probe is supplied", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);

    await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn<(q: string) => Promise<string>>(),
    });

    expect(errSpy.mock.calls.flat().join("\n")).not.toContain("already in use");
  });
});
