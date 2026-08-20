// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";
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

import {
  detectVllmProfile,
  installVllm as installVllmProduction,
  type InstallVllmOptions,
  type VllmProfile,
} from "./vllm";
import {
  applyVllmInstallProbeDefaults,
  createVllmInstallSpies,
  inconclusiveModelStorage,
  mockInconclusiveDockerStorage,
  mockSuccessfulVllmInstall,
  resetVllmInstallEnv,
  type VllmInstallSpies,
  withVllmInstallTestReadiness,
} from "./vllm-install.test-support";

function installVllm(profile: VllmProfile, options: InstallVllmOptions) {
  return installVllmProduction(profile, withVllmInstallTestReadiness(profile, options));
}

beforeEach(() => {
  applyVllmInstallProbeDefaults(mocks);
});

describe("managed vLLM install storage", () => {
  let errSpy: VllmInstallSpies["errSpy"];
  let mkdirSpy: VllmInstallSpies["mkdirSpy"];
  let restoreSpies: VllmInstallSpies["restore"];
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGpuIndicesByName.mockReturnValue([0]);
    mocks.tryInstallManagedClusterManagedVllm.mockResolvedValue({ kind: "not-selected" });
    ({ errSpy, mkdirSpy, restore: restoreSpies } = createVllmInstallSpies());
    resetVllmInstallEnv();
    process.env.HF_TOKEN = "hf_test";
  });

  afterEach(() => {
    restoreSpies();
    process.env = { ...originalEnv };
  });

  it.each([
    "n",
    "",
    "later",
  ])("stops a cold install when the storage warning receives '%s' (#6757)", async (storageReply) => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 1n,
        filesystemId: "docker-fs",
        path: "/docker-low",
        source: "Docker pull staging",
      },
    });
    const replies = ["y", storageReply];
    const promptFn = vi.fn(async () => replies.shift() ?? "");

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: false,
      promptFn,
    });

    expect(result).toEqual({ ok: false });
    expect(promptFn).toHaveBeenCalledTimes(2);
    expect(promptFn).toHaveBeenLastCalledWith("  Continue with the download anyway? [y/N]: ");
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("Insufficient storage for managed vLLM cold install");
    expect(errors).toContain(profile.image);
    expect(errors).toContain(profile.defaultModel.id);
    expect(errors).toContain("Available:");
    expect(errors).toContain("Required:");
    expect(errors).toContain("393.68 GB");
    expect(errors).toContain("docker system df");
  });

  it("stops a non-interactive Ultra download when the HF cache is too small (#9105)", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "nemotron-3-ultra-550b-a55b";
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
    mocks.probeHostStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 1n,
        filesystemId: "model-fs",
        path: path.join(os.homedir(), ".cache", "huggingface"),
        source: "Hugging Face cache",
      },
    });
    const promptFn = vi.fn();

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn,
    });

    expect(result).toEqual({ ok: false });
    expect(promptFn).not.toHaveBeenCalled();
    expect(mocks.probeHostStorage).toHaveBeenCalledTimes(1);
    expect(mocks.probeDockerStorage).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("Insufficient storage for managed vLLM model download");
    expect(errors).toContain("nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4");
    expect(errors).toContain("Hugging Face cache");
    expect(errors).toContain(
      "Non-interactive setup stops because confirmed available storage is insufficient",
    );
  });

  it.each([
    { reply: "y", expected: { ok: true }, pulls: 1, downloads: 1 },
    { reply: "n", expected: { ok: false }, pulls: 0, downloads: 0 },
    { reply: "", expected: { ok: false }, pulls: 0, downloads: 0 },
  ])("requires an explicit interactive '$reply' for a low model-cache warning", async ({
    reply,
    expected,
    pulls,
    downloads,
  }) => {
    process.env.NEMOCLAW_VLLM_MODEL = "nemotron-3-ultra-550b-a55b";
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
    mocks.probeHostStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 1n,
        filesystemId: "model-fs",
        path: path.join(os.homedir(), ".cache", "huggingface"),
        source: "Hugging Face cache",
      },
    });
    const replies = ["y", reply];
    const promptFn = vi.fn(async () => replies.shift() ?? "");

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: false,
      promptFn,
    });

    expect(result).toEqual(expected);
    expect(promptFn).toHaveBeenCalledTimes(2);
    expect(promptFn).toHaveBeenLastCalledWith("  Continue with the download anyway? [y/N]: ");
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(pulls);
    expect(mocks.dockerSpawn).toHaveBeenCalledTimes(downloads);
  });

  it("includes model download staging in the enforced cache requirement (#6858)", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "nemotron-3-ultra-550b-a55b";
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
    mocks.probeHostStorage.mockReturnValue({
      ok: true,
      capacity: {
        // This exceeds the model files plus writable allowance, but not the
        // additional 3 GiB required while the download is staged.
        availableBytes: 354_000_000_000n,
        filesystemId: "model-fs",
        path: path.join(os.homedir(), ".cache", "huggingface"),
        source: "Hugging Face cache",
      },
    });
    const replies = ["y", ""];
    const promptFn = vi.fn(async () => replies.shift() ?? "");

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: false,
      promptFn,
    });

    expect(result).toEqual({ ok: false });
    expect(promptFn).toHaveBeenCalledTimes(2);
    expect(promptFn).toHaveBeenLastCalledWith("  Continue with the download anyway? [y/N]: ");
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("Model staging:     3.221 GB");
    expect(errors).toContain("approximately 356.418 GB");
  });

  it("fails closed before downloads when non-interactive model-cache capacity is inconclusive", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "nemotron-3-ultra-550b-a55b";
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.probeHostStorage.mockReturnValue(inconclusiveModelStorage());
    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });
    expect(result).toEqual({ ok: false });
    expect(mocks.probeHostStorage).toHaveBeenCalledTimes(1);
    expect(mocks.dockerImageInspectFormat).toHaveBeenCalledTimes(1);
    expect(mocks.probeDockerStorage).toHaveBeenCalledTimes(1);
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("Unable to verify storage for managed vLLM cold install");
    expect(errors).toContain("statfs unavailable");
    expect(errors).toContain(
      "Non-interactive setup stops because model-cache capacity could not be verified",
    );
    expect(errors).toContain("Re-run interactively to review the warning");
  });

  it.each([
    { reply: "y", expected: { ok: true }, pulls: 1, downloads: 1 },
    { reply: "n", expected: { ok: false }, pulls: 0, downloads: 0 },
    { reply: "", expected: { ok: false }, pulls: 0, downloads: 0 },
  ])("requires an explicit interactive '$reply' for an inconclusive model-cache probe", async ({
    reply,
    expected,
    pulls,
    downloads,
  }) => {
    process.env.NEMOCLAW_VLLM_MODEL = "nemotron-3-ultra-550b-a55b";
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
    mocks.probeHostStorage.mockReturnValue(inconclusiveModelStorage());
    const replies = ["y", reply];
    const promptFn = vi.fn(async () => replies.shift() ?? "");

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: false,
      promptFn,
    });

    expect(result).toEqual(expected);
    expect(promptFn).toHaveBeenCalledTimes(2);
    expect(promptFn).toHaveBeenLastCalledWith("  Continue with the model download anyway? [y/N]: ");
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(pulls);
    expect(mocks.dockerSpawn).toHaveBeenCalledTimes(downloads);
  });

  it("re-probes after a cold image pull and stops before the model download (#9105)", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "nemotron-3-ultra-550b-a55b";
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.probeHostStorage
      // The model and image checks can each pass against this initial free
      // space even though their combined cold-download footprint cannot.
      .mockReturnValueOnce({
        ok: true,
        capacity: {
          availableBytes: 360_000_000_000n,
          filesystemId: "model-fs",
          path: path.join(os.homedir(), ".cache", "huggingface"),
          source: "Hugging Face cache",
        },
      })
      // Account for image layers consumed on the same filesystem.
      .mockReturnValueOnce({
        ok: true,
        capacity: {
          availableBytes: 340_000_000_000n,
          filesystemId: "model-fs",
          path: path.join(os.homedir(), ".cache", "huggingface"),
          source: "Hugging Face cache",
        },
      });

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.probeHostStorage).toHaveBeenCalledTimes(2);
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Insufficient storage for managed vLLM model download"),
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Non-interactive setup stops because confirmed available storage is insufficient",
      ),
    );
  });

  it("stops when the post-pull model-cache capacity re-probe is inconclusive", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "nemotron-3-ultra-550b-a55b";
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.probeHostStorage
      .mockReturnValueOnce({
        ok: true,
        capacity: {
          availableBytes: 1_000_000_000_000n,
          filesystemId: "model-fs",
          path: path.join(os.homedir(), ".cache", "huggingface"),
          source: "Hugging Face cache",
        },
      })
      .mockReturnValueOnce(inconclusiveModelStorage("statfs unavailable after image pull"));

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.probeHostStorage).toHaveBeenCalledTimes(2);
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unable to verify storage for managed vLLM model download"),
    );
  });

  it("requires only missing snapshot bytes plus headroom for a partial Ultra cache", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "nemotron-3-ultra-550b-a55b";
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
    mocks.measureDirectorySizeBytes.mockReturnValue(342_381_245_521n);
    mocks.probeHostStorage.mockReturnValue({
      ok: true,
      capacity: {
        // This covers the 10 GB remainder, download staging, and writable
        // allowance while remaining intentionally far below 352 GB.
        availableBytes: 15_000_000_000n,
        filesystemId: "model-fs",
        path: path.join(os.homedir(), ".cache", "huggingface"),
        source: "Hugging Face cache",
      },
    });

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.probeHostStorage).toHaveBeenCalledTimes(1);
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.dockerSpawn).toHaveBeenCalledTimes(1);
  });

  it("skips the capacity gate for a complete pinned Ultra snapshot", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "nemotron-3-ultra-550b-a55b";
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
    mocks.measureDirectorySizeBytes.mockReturnValue(352_381_245_521n);
    mocks.probeHostStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 1n,
        filesystemId: "model-fs",
        path: path.join(os.homedir(), ".cache", "huggingface"),
        source: "Hugging Face cache",
      },
    });

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.measureDirectorySizeBytes).toHaveBeenCalledTimes(1);
    expect(mocks.probeHostStorage).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).toHaveBeenCalledTimes(1);
  });

  it("continues an uncached image pull only after an explicit storage yes (#6757)", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 1n,
        filesystemId: "docker-fs",
        path: "/docker-low",
        source: "Docker root directory",
      },
    });
    const replies = ["y", "y"];
    const promptFn = vi.fn(async () => replies.shift() ?? "");

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: false,
      promptFn,
    });

    expect(result).toEqual({ ok: true });
    expect(promptFn).toHaveBeenCalledTimes(2);
    expect(promptFn).toHaveBeenLastCalledWith("  Continue with the download anyway? [y/N]: ");
    expect(mocks.dockerPullWithProgressWatchdog.mock.invocationCallOrder[0]).toBeGreaterThan(
      promptFn.mock.invocationCallOrder[1]!,
    );
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.dockerSpawn).toHaveBeenCalledTimes(1);
  });

  it("does not compare the total estimate against separate storage destinations (#6858)", async () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 39_000_000_000n,
        filesystemId: "docker-fs",
        path: "/docker-enough-for-image",
        source: "containerd image store",
      },
    });
    mocks.probeHostStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 357_000_000_000n,
        filesystemId: "model-fs",
        path: "/models-enough-for-model",
        source: "model cache",
      },
    });
    const promptFn = vi.fn(async () => "y");

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: false,
      promptFn,
    });

    expect(result).toEqual({ ok: true });
    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.dockerSpawn).toHaveBeenCalledTimes(1);
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).not.toContain("Insufficient storage for managed vLLM cold install");
  });

  it("enforces the aggregate estimate when image and model storage share a filesystem (#6858)", async () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 390_000_000_000n,
        filesystemId: "shared-fs",
        path: "/shared/docker",
        source: "containerd image store",
      },
    });
    mocks.probeHostStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 390_000_000_000n,
        filesystemId: "shared-fs",
        path: "/shared/huggingface",
        source: "model cache",
      },
    });
    const replies = ["y", ""];
    const promptFn = vi.fn(async () => replies.shift() ?? "");

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: false,
      promptFn,
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(promptFn).toHaveBeenLastCalledWith("  Continue with the download anyway? [y/N]: ");
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("Insufficient storage for managed vLLM cold install");
    expect(errors).toContain("Docker image storage + Model cache storage");
    expect(errors).toContain("393.68 GB");
  });

  it("conservatively aggregates storage when filesystem identity is unavailable (#6858)", async () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 390_000_000_000n,
        path: "/shared/docker",
        source: "containerd image store",
      },
    });
    mocks.probeHostStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 390_000_000_000n,
        path: "/shared/huggingface",
        source: "model cache",
      },
    });
    const replies = ["y", ""];
    const promptFn = vi.fn(async () => replies.shift() ?? "");

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: false,
      promptFn,
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(promptFn).toHaveBeenLastCalledWith("  Continue with the download anyway? [y/N]: ");
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("Insufficient storage for managed vLLM cold install");
    expect(errors).toContain("Docker image storage + Model cache storage");
    expect(errors).toContain("393.68 GB");
  });

  it("does not let an unknown probe mask verified low model-cache capacity (#6858)", async () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.probeDockerStorage.mockReturnValue({
      ok: false,
      reason: "Docker storage path could not be verified",
    });
    mocks.probeHostStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 1n,
        filesystemId: "model-fs",
        path: "/models-low",
        source: "model cache",
      },
    });
    const replies = ["y", ""];
    const promptFn = vi.fn(async () => replies.shift() ?? "");

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: false,
      promptFn,
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(promptFn).toHaveBeenLastCalledWith("  Continue with the download anyway? [y/N]: ");
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("Insufficient storage for managed vLLM cold install");
    expect(errors).toContain("Docker image storage: unknown");
    expect(errors).toContain("Model cache storage:");
  });

  it("uses conservative aggregate demand for generic Linux on a shared filesystem without cataloged unpacked size (#6858)", async () => {
    const profile = detectVllmProfile({ platform: "linux", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    // This fixed capacity is larger than either destination's requirement on
    // supported architectures, but smaller than their aggregate requirement.
    const sharedAvailableBytes = 35_000_000_000n;
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: sharedAvailableBytes,
        filesystemId: "generic-shared-fs",
        path: "/shared/docker",
        source: "Docker root directory",
      },
    });
    mocks.probeHostStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: sharedAvailableBytes,
        filesystemId: "generic-shared-fs",
        path: "/shared/huggingface",
        source: "model cache",
      },
    });
    const replies = ["y", ""];
    const promptFn = vi.fn(async () => replies.shift() ?? "");

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: false,
      promptFn,
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("Insufficient storage for managed vLLM cold install");
    expect(errors).toContain("Docker image storage + Model cache storage");
    expect(errors).toContain("Image unpacked:");
  });

  it("stops a non-interactive cold install after a confirmed low-storage warning (#9105)", async () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    process.env.NEMOCLAW_YES = "1";
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 1n,
        filesystemId: "docker-fs",
        path: "/docker-low",
        source: "containerd image store",
      },
    });

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Non-interactive setup stops because confirmed available storage is insufficient",
      ),
    );
  });

  it("stops a non-interactive cached-image install after a confirmed low model-cache warning (#9105)", async () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
    mocks.probeDockerStorage.mockImplementation(() => {
      throw new Error("cached image must not probe Docker image storage");
    });
    mocks.probeHostStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 1n,
        filesystemId: "model-fs",
        path: "/models-low",
        source: "model cache",
      },
    });

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.probeDockerStorage).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("Insufficient storage for managed vLLM model download");
    expect(errors).toContain("Model files:       352.381 GB");
    expect(errors).toContain("Required:");
    expect(errors).toContain('df -h "$HOME/.cache/huggingface"');
    expect(errors).toContain(
      "Non-interactive setup stops because confirmed available storage is insufficient",
    );
  });

  it("reports an inconclusive capacity check without blocking the cold install (#6757)", async () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mockInconclusiveDockerStorage(mocks);
    const promptFn = vi.fn();

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn,
    });

    expect(result).toEqual({ ok: true });
    expect(promptFn).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.dockerSpawn).toHaveBeenCalledTimes(1);
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("Unable to verify storage for managed vLLM cold install");
    expect(errors).toContain("Available: unknown (");
    expect(errors).toContain("Continuing because Docker storage capacity could not be verified");
  });

  it("reuses an authoritatively cached image without a cold-pull capacity check (#6757)", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
    mocks.probeDockerStorage.mockImplementation(() => {
      throw new Error("cached images must not probe cold-pull capacity");
    });

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.dockerImageInspectFormat).toHaveBeenCalledWith(
      "{{.Id}}",
      profile.image,
      expect.objectContaining({ env: expect.any(Object), ignoreError: true, timeout: 10_000 }),
    );
    expect(mocks.probeDockerStorage).not.toHaveBeenCalled();
    expect(mocks.probeHostStorage).toHaveBeenCalledTimes(1);
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.dockerSpawn).toHaveBeenCalledTimes(1);
    const [downloadArgs] = mocks.dockerSpawn.mock.calls[0] as [string[]];
    expect(downloadArgs).toContain("--pull=never");
  });

  it("guards a stale cached-image hint before any implicit pull can start (#6757)", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(mocks, profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("");
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 1n,
        filesystemId: "docker-fs",
        path: "/docker-low",
        source: "Docker root directory",
      },
    });
    const replies = ["y", "n"];

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: false,
      promptFn: vi.fn(async () => replies.shift() ?? ""),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.probeDockerStorage).toHaveBeenCalledTimes(1);
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
  });
});
