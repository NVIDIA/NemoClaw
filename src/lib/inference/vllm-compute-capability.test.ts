// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  computeCapabilityPreflight,
  detectVllmProfile,
  formatComputeCapability,
  gpuMemoryPreflight,
  installVllm as installVllmProduction,
  type InstallVllmOptions,
  readGpuComputeCapabilities,
  readGpuMemoryDevices,
  resolveVllmModelRuntime,
  selectVllmGpuDevice,
  type VllmProfile,
} from "./vllm";
import {
  applyVllmInstallProbeDefaults,
  createVllmInstallSpies,
  mockDockerSpawnSuccess,
  resetVllmInstallEnv,
  type VllmInstallSpies,
  vllmHostCommandCapture,
  withVllmInstallTestReadiness,
} from "./vllm-install.test-support";
import { VLLM_MODELS } from "./vllm-models";
import { NEMOCLAW_VLLM_GPU_DEVICE_ENV } from "./vllm-models";

const READY_MODELS_RESPONSE = '{"data":[]}';

function installVllm(profile: VllmProfile, options: InstallVllmOptions) {
  return installVllmProduction(profile, withVllmInstallTestReadiness(profile, options));
}

function mockHostCommands(options: {
  computeCap: string;
  curl?: string;
  gpuMemory?: string | readonly string[];
}): void {
  mocks.runCapture.mockImplementation(
    vllmHostCommandCapture({ curl: READY_MODELS_RESPONSE, ...options }),
  );
}

function mockDockerDaemon(containerName: string, restartCount = "0", logTail = ""): void {
  mocks.dockerPullWithProgressWatchdog.mockResolvedValue({
    status: 0,
    signal: null,
    output: "",
    timedOut: false,
    timeoutKind: null,
  });
  mocks.dockerSpawn.mockReturnValue(mockDockerSpawnSuccess());
  mocks.dockerRunDetached.mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
  mocks.dockerCapture.mockImplementation((args: readonly string[]) => {
    switch (args[0]) {
      case "container":
        return mocks.dockerRunDetached.mock.calls.length > 0
          ? `${"a".repeat(64)}|${containerName}|running|true|||\n`
          : "";
      case "ps":
        return `${containerName}\n`;
      case "inspect":
        return `${restartCount}\n`;
      case "logs":
        return logTail;
      default:
        return "";
    }
  });
}

describe("managed vLLM GPU compute capability preflight", () => {
  const quantizedModels = VLLM_MODELS.filter((model) => /FP8|NVFP4/.test(model.id));
  let errSpy: VllmInstallSpies["errSpy"];
  let restoreSpies: VllmInstallSpies["restore"];
  const originalEnv = { ...process.env };

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

  it("stops before the image pull and model download on a GPU below the checkpoint minimum (#8307)", async () => {
    const profile = detectVllmProfile({ type: "nvidia" });
    expect(profile).not.toBeNull();
    mockHostCommands({ computeCap: "8.0\n" });
    mockDockerDaemon(profile!.containerName);

    const result = await installVllm(profile!, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain(profile!.defaultModel.label);
    expect(errors).toContain("compute capability 8.9 or newer");
    expect(errors).toContain("this host reports 8.0");
    expect(errors).toContain("NEMOCLAW_VLLM_MODEL");
  });

  it("serves the checkpoint when the GPU meets the minimum (#8307)", async () => {
    const profile = detectVllmProfile({ type: "nvidia" });
    mockHostCommands({ computeCap: "8.9\n" });
    mockDockerDaemon(profile!.containerName);

    const result = await installVllm(profile!, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.dockerRunDetached).toHaveBeenCalledTimes(1);
  });

  it("serves the checkpoint when nvidia-smi reports no compute capability (#8307)", async () => {
    const profile = detectVllmProfile({ type: "nvidia" });
    mockHostCommands({ computeCap: "" });
    mockDockerDaemon(profile!.containerName);

    const result = await installVllm(profile!, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.dockerRunDetached).toHaveBeenCalledTimes(1);
  });

  it("reads every reported GPU and judges the host by its weakest one (#8307)", () => {
    mockHostCommands({ computeCap: "12.1\n8.0\nunavailable\n" });

    expect(readGpuComputeCapabilities()).toEqual([121, 80]);

    const model = VLLM_MODELS.find((entry) => entry.envValue === "nemotron-3-nano-4b");
    expect(computeCapabilityPreflight(model!, [121, 80])).toEqual({
      ok: false,
      reason: expect.stringContaining("this host reports 8.0"),
    });
    expect(computeCapabilityPreflight(model!, [121, 90])).toEqual({ ok: true });
  });

  it("queries compute capability for the selected GPU UUID", () => {
    mockHostCommands({ computeCap: "9.0\n" });

    expect(readGpuComputeCapabilities("GPU-69adb14e-820e-bfb4-0993-171e73f68504")).toEqual([90]);
    expect(mocks.runCapture).toHaveBeenCalledWith(
      expect.arrayContaining(["--id=GPU-69adb14e-820e-bfb4-0993-171e73f68504"]),
      expect.any(Object),
    );
  });

  it("prints a capability on the scale vLLM reports (#8307)", () => {
    expect(formatComputeCapability(80)).toBe("8.0");
    expect(formatComputeCapability(89)).toBe("8.9");
    expect(formatComputeCapability(121)).toBe("12.1");
  });

  it("includes quantized checkpoints in the registry (#8307)", () => {
    expect(quantizedModels.length).toBeGreaterThan(0);
  });

  it.each(quantizedModels)("declares a minimum compute capability for $id (#8307)", (model) => {
    // NVIDIA's published Lightning recipe explicitly covers A100 (8.0);
    // device-specific runtime variants may raise this floor (Spark uses 12.1).
    const expectedMinimum = model.envValue === "nemotron-3.5-lightning-30b" ? 80 : 89;
    expect(model.minComputeCapability).toBeGreaterThanOrEqual(expectedMinimum);
  });
});

describe("managed vLLM GPU memory preflight", () => {
  let errSpy: VllmInstallSpies["errSpy"];
  let restoreSpies: VllmInstallSpies["restore"];
  const originalEnv = { ...process.env };

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

  it("stops before downloads when the selected GPU lacks required memory", async () => {
    const detected = detectVllmProfile({ type: "nvidia" });
    expect(detected).not.toBeNull();
    const profile = { ...detected!, architecture: "x64" as const };
    process.env.NEMOCLAW_VLLM_MODEL = "muse-glimmer-30b";
    mockHostCommands({
      computeCap: "12.0\n",
      gpuMemory: "0, GPU-1234, 97887, 50360\n1, GPU-5678, 97887, 90000\n",
    });
    mockDockerDaemon(profile.containerName);

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("--gpu-memory-utilization=0.75");
    expect(errors).toContain("GPU 0");
    expect(errors).toContain("49.2 GiB of 95.6 GiB is free");
    expect(errors).toContain("free at least 22.5 GiB");
    expect(errors).toContain("then resume onboarding");
  });

  it("launches managed vLLM on the selected UUID and checks that GPU's free memory", async () => {
    const profile = { ...detectVllmProfile({ type: "nvidia" })!, architecture: "x64" as const };
    const uuid = "GPU-69adb14e-820e-bfb4-0993-171e73f68504";
    process.env.NEMOCLAW_VLLM_MODEL = "qwen3.6-27b";
    process.env[NEMOCLAW_VLLM_GPU_DEVICE_ENV] = uuid;
    mockHostCommands({
      computeCap: "9.0\n9.0\n",
      gpuMemory:
        `0, GPU-00000000-0000-0000-0000-000000000000, 97887, 1000\n` + `1, ${uuid}, 97887, 90000\n`,
    });
    mockDockerDaemon(profile.containerName);

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.tryInstallManagedClusterManagedVllm).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["--gpus", `device=${uuid}`]),
    );
  });

  it.each(["--gpu-memory-utilization", "--gpu_memory_utilization"])(
    "uses the effective %s override for the early preflight",
    async (option) => {
      const profile = detectVllmProfile({ type: "nvidia" })!;
      process.env.NEMOCLAW_VLLM_MODEL = "qwen3.6-27b";
      process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON = JSON.stringify([option, "0.9"]);
      mockHostCommands({
        computeCap: "9.0\n",
        gpuMemory: "0, GPU-1234, 100000, 80000\n",
      });
      mockDockerDaemon(profile.containerName);

      const result = await installVllm(profile, {
        hasImage: false,
        nonInteractive: true,
        promptFn: vi.fn(),
      });

      expect(result).toEqual({ ok: false });
      expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("sets --gpu-memory-utilization=0.9"),
      );
    },
  );

  it("does not apply the recipe default after a lower appended override", async () => {
    const profile = detectVllmProfile({ type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = "qwen3.6-27b";
    process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON = JSON.stringify(["--gpu-memory-utilization=0.5"]);
    mockHostCommands({
      computeCap: "9.0\n",
      gpuMemory: "0, GPU-1234, 100000, 60000\n",
    });
    mockDockerDaemon(profile.containerName);

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.dockerRunDetached).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.dockerRunDetached.mock.calls[0]?.[0])).toContain(
      "--gpu-memory-utilization=0.5",
    );
  });

  it("rechecks free memory after downloads and immediately before launch", async () => {
    const profile = detectVllmProfile({ type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = "qwen3.6-27b";
    mockHostCommands({
      computeCap: "9.0\n",
      gpuMemory: ["0, GPU-1234, 100000, 80000\n", "0, GPU-1234, 100000, 60000\n"],
    });
    mockDockerDaemon(profile.containerName);

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledOnce();
    expect(mocks.dockerSpawn).toHaveBeenCalledOnce();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("sets --gpu-memory-utilization=0.7"),
    );
  });

  it("fails closed when nvidia-smi returns no valid memory telemetry", async () => {
    const profile = detectVllmProfile({ type: "nvidia" })!;
    mockHostCommands({ computeCap: "9.0\n", gpuMemory: "malformed\n" });
    mockDockerDaemon(profile.containerName);

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not read valid GPU memory telemetry"),
    );
  });

  it("checks the first GPU selected by Docker instead of aggregating every device", () => {
    const detected = detectVllmProfile({ type: "nvidia" })!;
    const model = VLLM_MODELS.find((entry) => entry.envValue === "muse-glimmer-30b")!;
    const resolved = resolveVllmModelRuntime(detected, model, "x64");
    const profile = {
      ...resolved.profile,
      dockerRunFlags: ["--gpus", '"device=1,0"'],
    };
    const devices = [
      { index: 0, uuid: "GPU-1234", totalBytes: 96n, freeBytes: 40n },
      { index: 1, uuid: "GPU-5678", totalBytes: 96n, freeBytes: 80n },
    ];

    expect(profile.gpuMemoryUtilization).toBe(0.75);
    expect(gpuMemoryPreflight(model, profile, devices)).toEqual({ ok: true });
  });

  it("checks memory on the UUID selected for managed vLLM", () => {
    const detected = detectVllmProfile({ type: "nvidia" })!;
    const model = VLLM_MODELS.find((entry) => entry.envValue === "muse-glimmer-30b")!;
    const resolved = resolveVllmModelRuntime(detected, model, "x64");
    const profile = selectVllmGpuDevice(
      resolved.profile,
      "GPU-69adb14e-820e-bfb4-0993-171e73f68504",
    );

    expect(
      gpuMemoryPreflight(model, profile, [
        {
          index: 0,
          uuid: "GPU-00000000-0000-0000-0000-000000000000",
          totalBytes: 96n,
          freeBytes: 1n,
        },
        {
          index: 1,
          uuid: "GPU-69adb14e-820e-bfb4-0993-171e73f68504",
          totalBytes: 96n,
          freeBytes: 80n,
        },
      ]),
    ).toEqual({ ok: true });
  });

  it("fails closed when Docker's selected GPU is absent from telemetry", () => {
    const detected = detectVllmProfile({ type: "nvidia" })!;
    const model = VLLM_MODELS.find((entry) => entry.envValue === "muse-glimmer-30b")!;
    const resolved = resolveVllmModelRuntime(detected, model, "x64");
    const profile = {
      ...resolved.profile,
      dockerRunFlags: ["--gpus", '"device=2"'],
    };

    expect(
      gpuMemoryPreflight(model, profile, [
        { index: 0, uuid: "GPU-1234", totalBytes: 96n, freeBytes: 96n },
      ]),
    ).toEqual({
      ok: false,
      reason: expect.stringContaining("did not report that device"),
    });
  });

  it("ignores malformed nvidia-smi memory rows and keeps valid per-device telemetry", () => {
    mockHostCommands({
      computeCap: "12.0\n",
      gpuMemory: "malformed\n0, GPU-1234, 97887, 50360\n1, GPU-5678, N/A, N/A\n",
    });

    expect(readGpuMemoryDevices()).toEqual([
      {
        index: 0,
        uuid: "GPU-1234",
        totalBytes: 102_641_958_912n,
        freeBytes: 52_806_287_360n,
      },
    ]);
  });

  it("rejects missing telemetry for Docker's first selected GPU", () => {
    const detected = detectVllmProfile({ type: "nvidia" })!;
    const model = VLLM_MODELS.find((entry) => entry.envValue === "muse-glimmer-30b")!;
    const profile = { ...detected, gpuMemoryUtilization: 0.75 };

    expect(
      gpuMemoryPreflight(model, profile, [
        { index: 1, uuid: "GPU-1", totalBytes: 96n, freeBytes: 96n },
      ]),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        reason: expect.stringContaining("did not report that device"),
      }),
    );
  });
});

describe("managed vLLM crash-loop watchdog", () => {
  let errSpy: VllmInstallSpies["errSpy"];
  let stderrWrite: VllmInstallSpies["stderrWrite"];
  let restoreSpies: VllmInstallSpies["restore"];
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    applyVllmInstallProbeDefaults(mocks);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
    mocks.getGpuIndicesByName.mockReturnValue([0]);
    ({ errSpy, stderrWrite, restore: restoreSpies } = createVllmInstallSpies());
    resetVllmInstallEnv();
    process.env.HF_TOKEN = "hf_test";
  });

  afterEach(() => {
    restoreSpies();
    process.env = { ...originalEnv };
  });

  it("stops a container at the startup restart limit (#8307)", async () => {
    const profile = detectVllmProfile({ type: "nvidia" });
    mockHostCommands({ computeCap: "8.9\n", curl: "" });
    mockDockerDaemon(
      profile!.containerName,
      "3",
      "\u001b[31mValueError: insufficient free GPU memory\u001b[0m\r\nOPENAI_API_KEY=secret-value\u0007\u0000\nnvap\u0000i-ABCDEFGHIJKLMN",
    );

    const result = await installVllm(profile!, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerStop).toHaveBeenCalledTimes(1);
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("vLLM container restarted 3 times before readiness");
    const logsCall = mocks.dockerCapture.mock.calls.find(
      (call: unknown[]) => (call[0] as readonly string[])[0] === "logs",
    );
    expect(logsCall?.[1]).toMatchObject({ ignoreError: true, includeStderr: true });
    const printedTail = stderrWrite.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(printedTail).toContain("ValueError: insufficient free GPU memory");
    expect(printedTail).not.toContain("\u001b");
    expect(printedTail).not.toContain("secret-value");
    expect(printedTail).not.toContain("nvapi-ABCDEFGHIJKLMN");
    expect(printedTail).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
  });

  it("keeps waiting below the startup restart limit (#8307)", async () => {
    const profile = detectVllmProfile({ type: "nvidia" });
    mockHostCommands({ computeCap: "8.9\n" });
    mockDockerDaemon(profile!.containerName, "2");

    const result = await installVllm(profile!, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: true });
  });
});
