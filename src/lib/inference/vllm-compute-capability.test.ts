// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import fs from "node:fs";
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

import {
  computeCapabilityPreflight,
  detectVllmProfile,
  formatComputeCapability,
  installVllm,
  readGpuComputeCapabilities,
} from "./vllm";
import { VLLM_MODELS } from "./vllm-models";

const READY_MODELS_RESPONSE = '{"data":[]}';

function mockHostCommands(options: { computeCap: string; curl?: string }): void {
  mocks.runCapture.mockImplementation((cmd: readonly string[]) => {
    switch (cmd[0]) {
      case "sh":
        return "/usr/bin/tool\n";
      case "nvidia-smi":
        return options.computeCap;
      case "curl":
        return options.curl ?? READY_MODELS_RESPONSE;
      default:
        return "";
    }
  });
}

function mockDockerSpawnSuccess(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  process.nextTick(() => proc.emit("exit", 0));
  return proc;
}

function mockDockerDaemon(containerName: string, restartCount = "0"): void {
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
      default:
        return "";
    }
  });
}

describe("managed vLLM GPU compute capability preflight", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dockerImageInspectFormat.mockReturnValue("");
    mocks.findUnwritableModelCachePath.mockReturnValue(null);
    mocks.measureDirectorySizeBytes.mockReturnValue(0n);
    mocks.getGpuIndicesByName.mockReturnValue([0]);
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 1_000_000_000_000n,
        filesystemId: "docker-fs",
        path: "/docker",
        source: "Docker",
      },
    });
    mocks.probeHostStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 1_000_000_000_000n,
        filesystemId: "model-fs",
        path: path.join(os.homedir(), ".cache", "huggingface"),
        source: "Hugging Face cache",
      },
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    delete process.env.NEMOCLAW_VLLM_MODEL;
    delete process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON;
    process.env.HF_TOKEN = "hf_test";
    delete process.env.HUGGING_FACE_HUB_TOKEN;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    mkdirSpy.mockRestore();
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
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

  it("prints a capability on the scale vLLM reports (#8307)", () => {
    expect(formatComputeCapability(80)).toBe("8.0");
    expect(formatComputeCapability(89)).toBe("8.9");
    expect(formatComputeCapability(121)).toBe("12.1");
  });

  it("declares a minimum for every quantized checkpoint in the registry (#8307)", () => {
    const quantized = VLLM_MODELS.filter((model) => /FP8|NVFP4/.test(model.id));
    expect(quantized.length).toBeGreaterThan(0);
    for (const model of quantized) {
      expect(model.minComputeCapability, model.id).toBeGreaterThanOrEqual(89);
    }
  });
});

describe("managed vLLM crash-loop watchdog", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
    mocks.findUnwritableModelCachePath.mockReturnValue(null);
    mocks.measureDirectorySizeBytes.mockReturnValue(0n);
    mocks.getGpuIndicesByName.mockReturnValue([0]);
    mocks.probeHostStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 1_000_000_000_000n,
        filesystemId: "model-fs",
        path: path.join(os.homedir(), ".cache", "huggingface"),
        source: "Hugging Face cache",
      },
    });
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: {
        availableBytes: 1_000_000_000_000n,
        filesystemId: "docker-fs",
        path: "/docker",
        source: "Docker",
      },
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    delete process.env.NEMOCLAW_VLLM_MODEL;
    delete process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON;
    process.env.HF_TOKEN = "hf_test";
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    mkdirSpy.mockRestore();
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    process.env = { ...originalEnv };
  });

  it("stops a container at the startup restart limit (#8307)", async () => {
    const profile = detectVllmProfile({ type: "nvidia" });
    mockHostCommands({ computeCap: "8.9\n", curl: "" });
    mockDockerDaemon(profile!.containerName, "3");

    const result = await installVllm(profile!, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerStop).toHaveBeenCalledTimes(1);
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("vLLM container restarted 3 times before readiness");
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
