// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostLocalVllmSelectionResult } from "./serving/host-local-vllm-selection";
import type { VllmProfile } from "./vllm";

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
  resolveHostLocalVllmSelection: vi.fn<() => HostLocalVllmSelectionResult>(() => ({
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

async function resolveMuseGlimmerSelection(profile: VllmProfile): Promise<SelectedHostLocalVllm> {
  const readinessReports = vllmInstallTestReadiness(profile);
  const actualSelection = await vi.importActual<
    typeof import("./serving/host-local-vllm-selection")
  >("./serving/host-local-vllm-selection");
  const selection = actualSelection.resolveHostLocalVllmSelection(profile, process.env, {
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

  it("installs a fixed catalog recipe selected by NEMOCLAW_VLLM_MODEL", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "muse-glimmer-30b";
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const selection = await resolveMuseGlimmerSelection(profile);
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
  });

  it("still rejects extra serve arguments for a fixed catalog recipe", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "muse-glimmer-30b";
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const selection = await resolveMuseGlimmerSelection(profile);
    mocks.resolveHostLocalVllmSelection.mockReturnValue(selection);
    process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON = JSON.stringify(["--max-model-len", "4096"]);

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
      readinessReports: vllmInstallTestReadiness(profile),
    });

    expect(result).toEqual({ ok: false });
    expect(spies.errSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "does not accept NEMOCLAW_VLLM_MODEL or NEMOCLAW_VLLM_EXTRA_ARGS_JSON",
      ),
    );
    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
  });
});
