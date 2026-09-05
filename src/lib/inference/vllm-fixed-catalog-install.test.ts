// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostLocalVllmSelectionResult } from "./serving/host-local-vllm-selection";
import type { VllmProfile } from "./vllm";

type ResolveHostLocalVllmSelection = (typeof import("./serving/host-local-vllm-selection"))["resolveHostLocalVllmSelection"];

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
  persistHostLocalVllmRuntimeReceipt: vi.fn(),
  probeDockerStorage: vi.fn(),
  probeHostStorage: vi.fn(),
  resolveHostLocalVllmSelection: vi.fn<ResolveHostLocalVllmSelection>(() => ({
    kind: "not-selected",
  })),
  runCapture: vi.fn(),
  runCurlProbe: vi.fn(),
  tryInstallManagedClusterManagedVllm: vi.fn(async () => ({
    kind: "not-selected" as const,
  })),
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

vi.mock("../adapters/http/probe", () => ({
  runCurlProbe: mocks.runCurlProbe,
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
    persistHostLocalVllmRuntimeReceipt: mocks.persistHostLocalVllmRuntimeReceipt,
    resolveHostLocalVllmSelection: mocks.resolveHostLocalVllmSelection,
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
  vllmInstallTestReadiness,
} from "./vllm-install.test-support";

type SelectedHostLocalVllm = Extract<HostLocalVllmSelectionResult, { kind: "selected" }>;

async function resolveActualHostLocalSelection(
  profile: VllmProfile,
  env: NodeJS.ProcessEnv = process.env,
  modelIntent = String(env.NEMOCLAW_VLLM_MODEL ?? "").trim(),
): Promise<SelectedHostLocalVllm> {
  const readinessReports = vllmInstallTestReadiness(profile, modelIntent);
  const actualSelection = await vi.importActual<
    typeof import("./serving/host-local-vllm-selection")
  >("./serving/host-local-vllm-selection");
  const selection = actualSelection.resolveHostLocalVllmSelection(profile, env, {
    automatic: true,
    readinessReports,
  });
  expect(selection.kind).toBe("selected");
  return selection as SelectedHostLocalVllm;
}

function mockSuccessfulAuthenticatedReadiness(servedModelId: string): void {
  mocks.runCurlProbe
    .mockReturnValueOnce({
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      body: "",
      stderr: "",
      message: "",
    })
    .mockReturnValueOnce({
      ok: false,
      httpStatus: 401,
      curlStatus: 0,
      body: "",
      stderr: "",
      message: "HTTP 401",
    })
    .mockReturnValueOnce({
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      body: JSON.stringify({ data: [{ id: servedModelId }] }),
      stderr: "",
      message: "",
    });
}

describe("fixed catalog vLLM installs", () => {
  let spies: VllmInstallSpies;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    spies = createVllmInstallSpies();
    resetVllmInstallEnv();
    applyVllmInstallProbeDefaults(mocks);
    mocks.ensureDualStationVllmApiKey.mockReturnValue("b".repeat(64));
    mocks.getGpuIndicesByName.mockReturnValue([]);
    mocks.resolveHostLocalVllmSelection.mockReturnValue({ kind: "not-selected" });
    mocks.tryInstallManagedClusterManagedVllm.mockResolvedValue({ kind: "not-selected" });
  });

  afterEach(() => {
    spies.restore();
    process.env = { ...originalEnv };
  });

  it("reports automatic GPU memory rejection before install effects", async () => {
    const profile = detectVllmProfile({ platform: "n1x", type: "nvidia" })!;
    const availableMemoryBytes = 23_730_323_456;
    const readinessReports = vllmInstallTestReadiness(profile).map(({ nodeId, report }) => ({
      nodeId,
      report: {
        ...report,
        observations: report.observations.map((observation) =>
          observation.id === "host.gpu.memory_total_bytes" ||
          observation.id === "host.gpu.memory_per_device_bytes"
            ? { ...observation, value: availableMemoryBytes }
            : observation,
        ),
      },
    }));
    const actualSelection = await vi.importActual<
      typeof import("./serving/host-local-vllm-selection")
    >("./serving/host-local-vllm-selection");
    mocks.resolveHostLocalVllmSelection.mockImplementation((...args) =>
      actualSelection.resolveHostLocalVllmSelection(...args),
    );
    const reason = `vllm-install-test-host: GPU memory capacity ${String(availableMemoryBytes)} is below the recipe minimum 64000000000 bytes.`;

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
      readinessReports,
    });

    expect({
      result,
      errors: spies.errSpy.mock.calls,
      installEffects: {
        capture: mocks.runCapture.mock.calls.length,
        pull: mocks.dockerPullWithProgressWatchdog.mock.calls.length,
        run: mocks.dockerRunDetached.mock.calls.length,
      },
    }).toEqual({
      result: { ok: false },
      errors: expect.arrayContaining([[`  vLLM install failed: ${reason}`]]),
      installEffects: { capture: 0, pull: 0, run: 0 },
    });
  });

  it.each([
    { platform: "spark", model: "muse-glimmer-30b" },
    { platform: "linux", model: "inferact/muse-glimmer-30b-nvfp4-w4a4" },
    { platform: "spark", model: "NEMOTRON-3.5-LIGHTNING-30B" },
    {
      platform: "linux",
      model: "nvidia/nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4",
    },
  ] as const)(
    "installs the fixed $model catalog recipe on $platform",
    async ({ platform, model }) => {
      process.env.NEMOCLAW_VLLM_MODEL = model;
      const detectedProfile = detectVllmProfile({ platform, type: "nvidia" })!;
      const profile =
        platform === "linux"
          ? { ...detectedProfile, architecture: "x64" as const }
          : detectedProfile;
      const selection = await resolveActualHostLocalSelection(profile);
      const readinessReports = vllmInstallTestReadiness(profile);
      mocks.resolveHostLocalVllmSelection.mockReturnValue(selection);
      mockSuccessfulVllmInstall(mocks, selection.profile.containerName);
      mockSuccessfulAuthenticatedReadiness(selection.model.servedModelId ?? selection.model.id);

      const result = await installVllm(profile, {
        hasImage: true,
        nonInteractive: true,
        promptFn: vi.fn(),
        readinessReports,
        resolveManagedBridgeHost: () => "172.18.0.1",
      });

      expect(spies.errSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("does not accept NEMOCLAW_VLLM_MODEL"),
      );
      expect(result).toEqual({ ok: true });
      expect(mocks.dockerRunDetached).toHaveBeenCalledOnce();
    },
  );

  it("installs an explicitly selected fixed serving preset", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const modelIntent = "muse-glimmer-30b";
    const selectedByModel = await resolveActualHostLocalSelection(
      profile,
      { NEMOCLAW_VLLM_MODEL: modelIntent },
      modelIntent,
    );
    process.env.NEMOCLAW_SERVING_PRESET = selectedByModel.presetId;
    const selection = await resolveActualHostLocalSelection(profile, process.env, modelIntent);
    const readinessReports = vllmInstallTestReadiness(profile, modelIntent);
    mocks.resolveHostLocalVllmSelection.mockReturnValue(selection);
    mockSuccessfulVllmInstall(mocks, selection.profile.containerName);
    mockSuccessfulAuthenticatedReadiness(selection.model.servedModelId ?? selection.model.id);

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
      readinessReports,
      resolveManagedBridgeHost: () => "172.18.0.1",
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.dockerRunDetached).toHaveBeenCalledOnce();
  });

  it("defers non-interactive custom arguments to the established installer", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "qwen3.6-35b-a3b-nvfp4";
    process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON = '["--max-model-len","32768"]';
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const actualSelection = await vi.importActual<
      typeof import("./serving/host-local-vllm-selection")
    >("./serving/host-local-vllm-selection");
    const deferred = actualSelection.resolveHostLocalVllmSelection(profile, process.env, {
      automatic: true,
    });
    expect(deferred).toEqual({ kind: "not-selected" });
    mocks.resolveHostLocalVllmSelection.mockReturnValue(deferred);
    mockSuccessfulVllmInstall(mocks, profile.containerName);

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: true });
    const [runArgs] = mocks.dockerRunDetached.mock.calls[0] as [string[]];
    expect(runArgs.at(-1)).toContain("--max-model-len");
    expect(runArgs.at(-1)).toContain("32768");
  });

  it("replays and refreshes a checkpointed model before Docker download work", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const checkpointInstallIntent = vi.fn();
    mocks.resolveHostLocalVllmSelection.mockReturnValue({ kind: "not-selected" });
    mockSuccessfulVllmInstall(mocks, profile.containerName);

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
      modelIntent: "QWEN3.6-35B-A3B-NVFP4",
      checkpointInstallIntent,
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.resolveHostLocalVllmSelection).toHaveBeenCalledWith(
      profile,
      expect.objectContaining({ NEMOCLAW_VLLM_MODEL: "QWEN3.6-35B-A3B-NVFP4" }),
      expect.objectContaining({ automatic: true }),
    );
    expect(checkpointInstallIntent).toHaveBeenCalledWith("QWEN3.6-35B-A3B-NVFP4");
    expect(checkpointInstallIntent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dockerPullWithProgressWatchdog.mock.invocationCallOrder[0],
    );
  });

  it("still rejects extra serve arguments for a fixed catalog recipe", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "muse-glimmer-30b";
    process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON = JSON.stringify([
      "--max-model-len",
      "4096",
    ]);
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const actualSelection = await vi.importActual<
      typeof import("./serving/host-local-vllm-selection")
    >("./serving/host-local-vllm-selection");
    const deferred = actualSelection.resolveHostLocalVllmSelection(profile, process.env, {
      automatic: true,
    });
    expect(deferred).toEqual({ kind: "not-selected" });
    mocks.resolveHostLocalVllmSelection.mockReturnValue(deferred);

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
      readinessReports: vllmInstallTestReadiness(profile),
    });

    expect(result).toEqual({ ok: false });
    expect(spies.errSpy).toHaveBeenCalledWith(
      expect.stringContaining("does not accept NEMOCLAW_VLLM_EXTRA_ARGS_JSON"),
    );
    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
  });
});
