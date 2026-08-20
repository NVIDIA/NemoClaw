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
  ensureDualStationVllmApiKey: vi.fn(() => "b".repeat(64)),
  findUnwritableModelCachePath: vi.fn(),
  getGpuIndicesByName: vi.fn<(_pattern: RegExp) => number[]>(() => []),
  measureDirectorySizeBytes: vi.fn(),
  probeDockerStorage: vi.fn(),
  probeHostStorage: vi.fn(),
  recoverHostLocalManagedVllmEndpoint: vi.fn(),
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
    ensureDualStationVllmApiKey: mocks.ensureDualStationVllmApiKey,
    recoverHostLocalManagedVllmEndpoint: mocks.recoverHostLocalManagedVllmEndpoint,
    tryInstallManagedClusterManagedVllm: mocks.tryInstallManagedClusterManagedVllm,
  };
});

import {
  detectVllmProfile,
  installVllm as installVllmProduction,
  type InstallVllmOptions,
  type VllmProfile,
} from "./vllm";
import {
  applyVllmInstallProbeDefaults,
  createVllmInstallSpies,
  MANAGED_CONTAINER_ID,
  mockSuccessfulVllmInstall,
  resetVllmInstallEnv,
  type VllmInstallSpies,
  vllmContainerRow,
  withVllmInstallTestReadiness,
} from "./vllm-install.test-support";

function installVllm(profile: VllmProfile, options: InstallVllmOptions) {
  return installVllmProduction(profile, withVllmInstallTestReadiness(profile, options));
}

describe("managed vLLM serving-port guard (#8685)", () => {
  const originalEnv = { ...process.env };
  let errSpy: VllmInstallSpies["errSpy"];
  let restoreSpies: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    applyVllmInstallProbeDefaults(mocks);
    mocks.getGpuIndicesByName.mockReturnValue([0]);
    mocks.recoverHostLocalManagedVllmEndpoint.mockReturnValue(null);
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

    const result = await installVllm(
      profile,
      withVllmInstallTestReadiness(profile, {
        hasImage: true,
        nonInteractive: true,
        promptFn,
        checkServingPort,
      }),
    );

    expect(result).toEqual({ ok: false });
    expect(checkServingPort).toHaveBeenCalledWith(8000);
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    const reported = errSpy.mock.calls.flat().join("\n");
    expect(reported).toContain("port 8000 is already in use");
    expect(reported).toContain("PID 4242");
    expect(reported).not.toContain("exit 125");
  });

  it("replaces a validated interrupted managed container that holds the serving port", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const managed = vllmContainerRow(profile.containerName);
    mockSuccessfulVllmInstall(mocks, profile.containerName, [() => managed, () => managed]);
    mocks.recoverHostLocalManagedVllmEndpoint.mockReturnValue({
      baseUrl: "http://127.0.0.1:8000",
      apiKey: "b".repeat(64),
      containerId: MANAGED_CONTAINER_ID,
    });
    const checkServingPort = vi.fn(async () => ({ ok: false, reason: "port 8000 is held" }));

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn<(q: string) => Promise<string>>(),
      checkServingPort,
    });

    expect(result).toEqual({ ok: true });
    expect(checkServingPort).toHaveBeenCalledWith(8000);
    expect(mocks.recoverHostLocalManagedVllmEndpoint).toHaveBeenCalledOnce();
    expect(mocks.dockerForceRm).toHaveBeenCalledWith(
      MANAGED_CONTAINER_ID,
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(mocks.dockerRunDetached).toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join("\n")).not.toContain("another process");
  });

  it("rejects a recovered managed container bound to a different port", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.recoverHostLocalManagedVllmEndpoint.mockReturnValue({
      baseUrl: "http://127.0.0.1:19000",
      apiKey: "b".repeat(64),
      containerId: MANAGED_CONTAINER_ID,
    });

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn<(q: string) => Promise<string>>(),
      checkServingPort: async () => ({ ok: false, reason: "port 8000 is held" }),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.recoverHostLocalManagedVllmEndpoint).toHaveBeenCalledOnce();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerForceRm).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join("\n")).toContain("port 8000 is already in use");
  });

  it("fails closed when the managed container changes immediately before replacement", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName, [
      () => vllmContainerRow(profile.containerName),
      () => vllmContainerRow(profile.containerName, { id: "c".repeat(64) }),
    ]);
    mocks.recoverHostLocalManagedVllmEndpoint.mockReturnValue({
      baseUrl: "http://127.0.0.1:8000",
      apiKey: "b".repeat(64),
      containerId: MANAGED_CONTAINER_ID,
    });

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn<(q: string) => Promise<string>>(),
      checkServingPort: async () => ({ ok: false, reason: "port 8000 is held" }),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalled();
    expect(mocks.dockerForceRm).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("changed after recovery"));
  });

  it("fails closed when a managed container holding the serving port cannot be recovered", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.recoverHostLocalManagedVllmEndpoint.mockImplementation(() => {
      throw new Error("Managed host-local vLLM runtime does not match its ownership receipt.");
    });

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn<(q: string) => Promise<string>>(),
      checkServingPort: async () => ({ ok: false, reason: "port 8000 is held" }),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerForceRm).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join("\n")).toContain(
      "managed host-local vLLM recovery could not verify the container",
    );
  });

  it("rejects the port before the storage decisions or the cache directory", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);

    const result = await installVllm(
      profile,
      withVllmInstallTestReadiness(profile, {
        hasImage: true,
        nonInteractive: true,
        promptFn: vi.fn<(q: string) => Promise<string>>(),
        checkServingPort: async () => ({ ok: false, reason: "port 8000 is held" }),
      }),
    );

    // The storage probes are the first step that can prompt, and the cache
    // directory is created immediately after them. Neither may run for a
    // conflict the install is going to refuse.
    expect(result).toEqual({ ok: false });
    expect(mocks.probeHostStorage).not.toHaveBeenCalled();
    expect(mocks.probeDockerStorage).not.toHaveBeenCalled();
    expect(mocks.measureDirectorySizeBytes).not.toHaveBeenCalled();
  });

  it("rejects the port before persisting managed auth or publishing the selection", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "muse-glimmer-30b";
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    const beforeInstall = vi.fn();

    const result = await installVllm(
      profile,
      withVllmInstallTestReadiness(profile, {
        hasImage: true,
        nonInteractive: true,
        promptFn: vi.fn<(q: string) => Promise<string>>(),
        beforeInstall,
        checkServingPort: async () => ({ ok: false, reason: "port 8000 is held" }),
      }),
    );

    expect(result).toEqual({ ok: false });
    expect(mocks.ensureDualStationVllmApiKey).not.toHaveBeenCalled();
    expect(beforeInstall).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join("\n")).not.toContain("NEMOCLAW_VLLM_PORT");
  });

  it("proceeds past the guard when the serving port is free", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    const checkServingPort = vi.fn(async () => ({ ok: true }));

    await installVllm(
      profile,
      withVllmInstallTestReadiness(profile, {
        hasImage: true,
        nonInteractive: true,
        promptFn: vi.fn<(q: string) => Promise<string>>(),
        checkServingPort,
      }),
    );

    expect(checkServingPort).toHaveBeenCalledWith(8000);
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join("\n")).not.toContain("already in use");
  });

  it("installs unguarded when no probe is supplied", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);

    const result = await installVllm(
      profile,
      withVllmInstallTestReadiness(profile, {
        hasImage: true,
        nonInteractive: true,
        promptFn: vi.fn<(q: string) => Promise<string>>(),
      }),
    );

    // Assert the install reaches the end, so an early return added ahead of the
    // guard cannot pass this case by merely staying silent.
    expect(result).toEqual({ ok: true });
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalled();
    expect(mocks.dockerRunDetached).toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join("\n")).not.toContain("already in use");
  });
});
