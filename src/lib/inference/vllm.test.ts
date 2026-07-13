// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
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
  getGpuIndicesByName: vi.fn<(_pattern: RegExp) => number[]>(() => []),
  probeDockerBindIdentity: vi.fn(),
  probeDockerHostLocality: vi.fn(),
  probeDockerStorage: vi.fn(),
  probeModelCacheStorage: vi.fn(),
  runCapture: vi.fn(),
}));

vi.mock("../runner", () => ({
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
    probeDockerBindIdentity: mocks.probeDockerBindIdentity,
    probeDockerHostLocality: mocks.probeDockerHostLocality,
    probeDockerStorage: mocks.probeDockerStorage,
    probeModelCacheStorage: mocks.probeModelCacheStorage,
  };
});

import {
  buildVllmRunArgs,
  detectVllmProfile,
  installVllm,
  pullImage,
  resolveVllmServedModelId,
} from "./vllm";

beforeEach(() => {
  mocks.dockerImageInspectFormat.mockReturnValue("");
  mocks.probeDockerBindIdentity.mockReturnValue({ ok: true });
  mocks.probeDockerHostLocality.mockReturnValue({ ok: true });
  mocks.probeDockerStorage.mockReturnValue({
    ok: true,
    capacity: { availableBytes: 1_000_000_000_000n, path: "/docker", source: "Docker" },
  });
  mocks.probeModelCacheStorage.mockReturnValue({
    ok: true,
    capacity: { availableBytes: 1_000_000_000_000n, path: "/models", source: "model cache" },
  });
});

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

function mockSuccessfulVllmInstall(containerName: string): void {
  const captureByCommand: Record<string, string> = {
    curl: '{"data":[]}',
    sh: "/usr/bin/tool\n",
  };
  mocks.runCapture.mockImplementation(
    (cmd: readonly string[]) => captureByCommand[cmd[0] ?? ""] ?? "",
  );
  mocks.dockerPullWithProgressWatchdog.mockResolvedValue({
    status: 0,
    signal: null,
    output: "",
    timedOut: false,
    timeoutKind: null,
  });
  mocks.dockerSpawn.mockReturnValue(mockDockerSpawnSuccess());
  mocks.dockerRunDetached.mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
  mocks.dockerCapture.mockReturnValue(`${containerName}\n`);
}

function mockInconclusiveDockerStorage(): void {
  mocks.probeDockerStorage.mockReturnValue({
    ok: false,
    reason: "Docker uses a remote endpoint (ssh://builder.example.test)",
  });
}

function mockInconclusiveModelCacheStorage(): void {
  mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
  mocks.probeModelCacheStorage.mockReturnValue({
    ok: false,
    reason: "could not inspect the model cache: permission denied",
  });
}

describe("vLLM served route identity", () => {
  it("uses one safe served-model override and rejects ambiguous aliases (#6315)", () => {
    expect(resolveVllmServedModelId("catalog/model", [])).toBe("catalog/model");
    expect(resolveVllmServedModelId("catalog/model", ["--served-model-name", "served/model"])).toBe(
      "served/model",
    );
    expect(() =>
      resolveVllmServedModelId("catalog/model", [
        "--served-model-name",
        "served/one",
        "served/two",
      ]),
    ).toThrow("exactly one safe model ID");
  });
});

describe("vLLM profile detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses DeepSeek V4 Flash and the 26.05.post1 NGC image on DGX Station", () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("DGX Station");
    expect(profile!.image).toBe(
      "nvcr.io/nvidia/vllm@sha256:9204569b17ee4c0eff75194b8e6e458479c8aee18953b5ab9cf359fcdac659e2",
    );
    expect(profile!.imageDownloadSizeBytes).toBe(9_603_085_145);
    expect(profile!.defaultModel.id).toBe("deepseek-ai/DeepSeek-V4-Flash");
    expect(profile!.defaultModel.envValue).toBe("deepseek-v4-flash");
  });

  it("keeps DGX Spark on the Qwen3.6 35B NVFP4 default", () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" });

    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("DGX Spark");
    expect(profile!.image).toBe(
      "nvcr.io/nvidia/vllm@sha256:9204569b17ee4c0eff75194b8e6e458479c8aee18953b5ab9cf359fcdac659e2",
    );
    expect(profile!.defaultModel.id).toBe("nvidia/Qwen3.6-35B-A3B-NVFP4");
    expect(profile!.defaultModel.envValue).toBe("qwen3.6-35b-a3b-nvfp4");
  });

  it.each([
    {
      arch: "arm64",
      image:
        "nvcr.io/nvidia/vllm@sha256:447995cbb57e6c7cf792cab95e9852e5f62b5fb6d2f39e030fa4eda9a54eadb4",
      imageDownloadSizeBytes: 9_278_081_698,
    },
    {
      arch: "x64",
      image:
        "nvcr.io/nvidia/vllm@sha256:7be6c2f676c36059a494fe17254e69ae5c677535ba6191044e5fc8e42a91c773",
      imageDownloadSizeBytes: 8_928_665_752,
    },
  ] as const)("keeps generic Linux on the smaller Nemotron Nano default for $arch", async ({
    arch,
    image,
    imageDownloadSizeBytes,
  }) => {
    const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
    try {
      Object.defineProperty(process, "arch", { configurable: true, value: arch });
      vi.resetModules();
      const { detectVllmProfile: detectVllmProfileForArch } = await import("./vllm");

      const profile = detectVllmProfileForArch({ platform: "linux", type: "nvidia" });

      expect(profile).not.toBeNull();
      expect(profile!.name).toBe("Linux + NVIDIA GPU");
      expect(profile!.image).toBe(image);
      expect(profile!.imageDownloadSizeBytes).toBe(imageDownloadSizeBytes);
      expect(profile!.defaultModel.id).toBe("nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8");
      expect(profile!.defaultModel.envValue).toBe("nemotron-3-nano-4b");
    } finally {
      Object.defineProperty(process, "arch", originalArch);
      vi.resetModules();
    }
  });

  it("generic-Linux default model pins the tool-call flags (#6314)", () => {
    // Regression for #6314: without --enable-auto-tool-choice + --tool-call-parser,
    // agent requests that set `tool_choice: "auto"` fail HTTP 400 out of the box
    // on the generic-Linux managed vLLM default. The Spark and Station defaults
    // already carry their own tool-call parsers; this asserts the Linux default
    // does too, matching the vLLM launch example on the model card.
    const profile = detectVllmProfile({ platform: "linux", type: "nvidia" });
    expect(profile).not.toBeNull();
    const args = profile!.defaultModel.modelArgs;
    expect(args).toContain("--enable-auto-tool-choice");
    const parserIdx = args.indexOf("--tool-call-parser");
    expect(parserIdx).toBeGreaterThanOrEqual(0);
    expect(args[parserIdx + 1]).toBe("qwen3_coder");
  });
});

describe("vLLM image pull", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
  });

  it("uses the progress watchdog with the profile safety budget and progress emitter", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" });
    expect(profile).not.toBeNull();
    mocks.dockerPullWithProgressWatchdog.mockResolvedValue({
      status: 0,
      signal: null,
      output: "",
      timedOut: false,
      timeoutKind: null,
    });

    await expect(pullImage(profile!)).resolves.toEqual({ ok: true });

    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledWith(
      profile!.image,
      expect.objectContaining({
        env: expect.any(Object),
        maxTimeoutMs: profile!.pullTimeoutSec * 1000,
        logLine: expect.any(Function),
      }),
    );
    const options = mocks.dockerPullWithProgressWatchdog.mock.calls[0][1];
    options.logLine("abc123def: Downloading 1MB/10MB");
    expect(stdoutWrite).toHaveBeenCalledWith("  ==> abc123def: Downloading 1MB/10MB\n");
  });

  it.each([
    [
      "stall timeout",
      { status: 124, signal: "SIGTERM", output: "", timedOut: true, timeoutKind: "stall" },
      "docker pull stalled with no progress",
    ],
    [
      "max timeout",
      { status: 124, signal: "SIGTERM", output: "", timedOut: true, timeoutKind: "max" },
      "docker pull exceeded 43200s safety budget",
    ],
    [
      "non-timeout failure",
      { status: 17, signal: null, output: "", timedOut: false, timeoutKind: null },
      "docker pull failed (exit 17)",
    ],
  ])("maps %s to the install failure reason", async (_name, result, reason) => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" });
    expect(profile).not.toBeNull();
    mocks.dockerPullWithProgressWatchdog.mockResolvedValue(result);

    await expect(pullImage(profile!)).resolves.toEqual({ ok: false, reason });
  });
});

describe("vLLM run command", () => {
  it("adds --restart unless-stopped so the container survives a host reboot (#4886)", () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" });
    expect(profile).not.toBeNull();
    const args = buildVllmRunArgs(profile!, profile!.defaultModel, profile!.dockerRunFlags);
    expect(args.slice(0, 3)).toEqual(["--pull=never", "--restart", "unless-stopped"]);
    expect(args).toContain("--name");
    expect(args[args.indexOf("--name") + 1]).toBe(profile!.containerName);
    expect(args).toContain("8000:8000");
  });

  it("preserves profile run flags and image as argv tokens", () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });
    expect(profile).not.toBeNull();
    const args = buildVllmRunArgs(profile!, profile!.defaultModel, [
      "--gpus",
      '"device=0,1"',
      "--ipc=host",
    ]);
    expect(args).toEqual(expect.arrayContaining(["--gpus", '"device=0,1"', "--ipc=host"]));
    expect(args).toContain(profile!.image);
    expect(args).toEqual(expect.arrayContaining(["--entrypoint", "/bin/bash"]));
    expect(args.join(" ")).not.toContain("docker run");
  });

  it("keeps shell metacharacters in Docker argv tokens instead of shell composing them", () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" });
    expect(profile).not.toBeNull();
    const labelValue = "profile=$(touch /tmp/nemoclaw-vllm-pwn)";
    const args = buildVllmRunArgs(profile!, profile!.defaultModel, ["--label", labelValue], {
      HF_TOKEN: "hf_test",
    } as NodeJS.ProcessEnv);

    expect(args).toEqual(expect.arrayContaining(["--label", labelValue, "-e", "HF_TOKEN"]));
    expect(args).not.toContain(`--label ${labelValue}`);
    expect(args).not.toContain("-e HF_TOKEN");
    expect(args.join(" ")).not.toContain("hf_test");
  });

  it("rejects empty and NUL-bearing Docker argv tokens", () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" });
    expect(profile).not.toBeNull();

    expect(() => buildVllmRunArgs(profile!, profile!.defaultModel, ["--label", ""])).toThrow(
      "must not be empty",
    );
    expect(() =>
      buildVllmRunArgs(profile!, profile!.defaultModel, ["--label", "unsafe\0value"]),
    ).toThrow("must not contain NUL bytes");
  });

  it("uses os.homedir for the Hugging Face cache mount without shell quoting", () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" });
    expect(profile).not.toBeNull();
    const mount = profile!.dockerRunFlags[profile!.dockerRunFlags.indexOf("-v") + 1];

    expect(mount).toBe(
      `${path.join(os.homedir(), ".cache", "huggingface")}:/root/.cache/huggingface`,
    );
  });

  it("keeps Docker CSV quoting inside the Station multi-GPU argv token", () => {
    mocks.getGpuIndicesByName.mockReturnValue([0, 1]);
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });
    expect(profile).not.toBeNull();
    const flags = profile!.buildDockerRunFlags!();

    expect(flags).toEqual(expect.arrayContaining(["--gpus", '"device=0,1"']));
    expect(flags).not.toContain("device=0,1");
    expect(flags).not.toContain(`'"device=0,1"'`);
  });
});

describe("installVllm model resolution", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    delete process.env.NEMOCLAW_VLLM_MODEL;
    delete process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON;
    delete process.env.NEMOCLAW_IGNORE_VLLM_DISK_SPACE;
    delete process.env.HF_TOKEN;
    delete process.env.HUGGING_FACE_HUB_TOKEN;
    // Fail dockerPrereqsOk so the function returns before any docker work,
    // letting tests assert on the resolved model + summary line without
    // mocking the full install chain.
    mocks.runCapture.mockReturnValue("");
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    stdoutWrite.mockRestore();
    process.env = { ...originalEnv };
  });

  it("uses the profile default and skips the picker in non-interactive mode", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const promptFn = vi.fn<(q: string) => Promise<string>>();

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn,
    });

    expect(result).toEqual({ ok: false });
    expect(promptFn).not.toHaveBeenCalled();
    const summary = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(summary).toContain("Model: nvidia/Qwen3.6-35B-A3B-NVFP4");
    expect(summary).not.toContain("NEMOCLAW_VLLM_MODEL override");
  });

  it("annotates the summary as a NEMOCLAW_VLLM_MODEL override when the env var resolves", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "qwen3.6-27b";
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const promptFn = vi.fn<(q: string) => Promise<string>>();

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn,
    });

    expect(result).toEqual({ ok: false });
    expect(promptFn).not.toHaveBeenCalled();
    const summary = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(summary).toContain("Model: Qwen/Qwen3.6-27B-FP8 (NEMOCLAW_VLLM_MODEL override)");
  });

  it("offers the interactive picker when no env override is set", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const queue = ["", "n"];
    const promptFn = vi.fn<(q: string) => Promise<string>>(async () => queue.shift() ?? "");

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: false,
      promptFn,
    });

    expect(result).toEqual({ ok: false });
    const questions = promptFn.mock.calls.map((c: [string]) => c[0]);
    expect(questions.length).toBeGreaterThanOrEqual(2);
    expect(questions[0]).toContain("Choose model [1]");
    expect(questions[1]).toContain("Continue?");
  });

  it("fails the env override before any docker work when a gated model has no HF token", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "deepseek-r1-distill-70b";
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const promptFn = vi.fn<(q: string) => Promise<string>>();

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn,
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.runCapture).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(errors).toMatch(/gated on Hugging Face/);
  });

  it("guards the effective served model before any docker work (#6315)", async () => {
    process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON = JSON.stringify([
      "--served-model-name",
      "shared/served-model",
    ]);
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const beforeInstall = vi.fn();

    await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
      beforeInstall,
    });

    expect(beforeInstall).toHaveBeenCalledWith("shared/served-model");
    expect(beforeInstall.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runCapture.mock.invocationCallOrder[0],
    );
  });

  it("performs no Docker work when the shared-gateway guard rejects installation (#6315)", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;

    await expect(
      installVllm(profile, {
        hasImage: true,
        nonInteractive: true,
        promptFn: vi.fn(),
        beforeInstall: () => {
          throw new Error("route conflict");
        },
      }),
    ).rejects.toThrow("route conflict");

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
  });

  it.each([
    "n",
    "",
    "later",
  ])("stops an uncached image pull when the storage warning receives '%s' (#6757)", async (storageReply) => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: { availableBytes: 1n, path: "/docker-low", source: "Docker pull staging" },
    });
    const replies = ["y", storageReply];

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: false,
      promptFn: vi.fn(async () => replies.shift() ?? ""),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("Insufficient Docker storage for the managed vLLM image");
    expect(errors).toContain(profile.image);
    expect(errors).toContain("Available:");
    expect(errors).toContain("Required:");
    expect(errors).toContain("docker system df");
  });

  it("continues an uncached image pull only after an explicit storage yes (#6757)", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: { availableBytes: 1n, path: "/docker-low", source: "Docker root directory" },
    });
    const replies = ["y", "y"];

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: false,
      promptFn: vi.fn(async () => replies.shift() ?? ""),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.dockerSpawn).toHaveBeenCalledTimes(1);
  });

  it("fails safely before downloads in non-interactive low-storage setup (#6757)", async () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    process.env.NEMOCLAW_YES = "1";
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: { availableBytes: 1n, path: "/docker-low", source: "containerd image store" },
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
      expect.stringContaining("Non-interactive setup stops before the guarded download"),
    );
  });

  it.each([
    {
      name: "inconclusive Docker storage in non-interactive mode",
      hasImage: false,
      nonInteractive: true,
      replies: [],
      expectedPromptCalls: 0,
      expectedWarning: "Unable to verify Docker storage for the managed vLLM image",
      setup: mockInconclusiveDockerStorage,
    },
    {
      name: "inconclusive Docker storage after an interactive decline",
      hasImage: false,
      nonInteractive: false,
      replies: ["y", "n"],
      expectedPromptCalls: 2,
      expectedWarning: "Unable to verify Docker storage for the managed vLLM image",
      setup: mockInconclusiveDockerStorage,
    },
    {
      name: "inconclusive model-cache storage in non-interactive mode",
      hasImage: true,
      nonInteractive: true,
      replies: [],
      expectedPromptCalls: 0,
      expectedWarning: "Unable to verify model-cache storage for managed vLLM",
      setup: mockInconclusiveModelCacheStorage,
    },
    {
      name: "inconclusive model-cache storage after an interactive decline",
      hasImage: true,
      nonInteractive: false,
      replies: ["y", "n"],
      expectedPromptCalls: 2,
      expectedWarning: "Unable to verify model-cache storage for managed vLLM",
      setup: mockInconclusiveModelCacheStorage,
    },
  ] as const)("$name stops before guarded downloads (#6757)", async (testCase) => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(profile.containerName);
    testCase.setup();
    const replies = [...testCase.replies];
    const promptFn = vi.fn(async () => replies.shift() ?? "");

    const result = await installVllm(profile, {
      hasImage: testCase.hasImage,
      nonInteractive: testCase.nonInteractive,
      promptFn,
    });

    expect(result).toEqual({ ok: false });
    expect(promptFn).toHaveBeenCalledTimes(testCase.expectedPromptCalls);
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain(testCase.expectedWarning);
    expect(errors).toContain("Available: unknown (");
  });

  it("does not pull an uncached image when a nested PID namespace hides the Docker peer (#6757)", async () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.probeDockerStorage.mockReturnValue({
      ok: false,
      reason: "Docker socket peer PID or mount namespace could not be verified",
    });

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.probeDockerStorage).toHaveBeenCalledTimes(1);
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.probeDockerBindIdentity).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Docker socket peer PID or mount namespace could not be verified"),
    );
  });

  it("honors only the dedicated disk-space override in non-interactive setup (#6757)", async () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    process.env.NEMOCLAW_IGNORE_VLLM_DISK_SPACE = "1";
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: { availableBytes: 1n, path: "/docker-low", source: "containerd image store" },
    });
    mocks.probeModelCacheStorage.mockReturnValue({
      ok: true,
      capacity: { availableBytes: 1n, path: "/models-low", source: "model cache" },
    });

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.dockerSpawn).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("NEMOCLAW_IGNORE_VLLM_DISK_SPACE=1"),
    );
  });

  it("stops before either download when model-cache capacity is declined (#6757)", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.probeModelCacheStorage.mockReturnValue({
      ok: true,
      capacity: { availableBytes: 1n, path: "/models-low", source: "model cache" },
    });
    const replies = ["y", "n"];

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: false,
      promptFn: vi.fn(async () => replies.shift() ?? ""),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("Insufficient model-cache storage for managed vLLM");
    expect(errors).toContain(profile.defaultModel.id);
  });

  it("reuses an authoritatively cached image without a cold-pull capacity check (#6757)", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName);
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
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.dockerSpawn).toHaveBeenCalledTimes(1);
    const [downloadArgs] = mocks.dockerSpawn.mock.calls[0] as [string[]];
    expect(downloadArgs).toContain("--pull=never");
  });

  it("guards a stale cached-image hint before any implicit pull can start (#6757)", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("");
    mocks.probeDockerStorage.mockReturnValue({
      ok: true,
      capacity: { availableBytes: 1n, path: "/docker-low", source: "Docker root directory" },
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

  it("rechecks model capacity after the image pull before hf download (#6757)", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.probeModelCacheStorage
      .mockReturnValueOnce({
        ok: true,
        capacity: {
          availableBytes: 1_000_000_000_000n,
          path: "/shared",
          source: "model cache",
        },
      })
      .mockReturnValueOnce({
        ok: true,
        capacity: { availableBytes: 1n, path: "/shared", source: "model cache" },
      });

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.probeDockerHostLocality).toHaveBeenCalledTimes(1);
    expect(mocks.probeDockerBindIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.probeModelCacheStorage).toHaveBeenCalledTimes(2);
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
  });

  it("rechecks model capacity for a cached image before hf download (#6757)", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
    mocks.probeModelCacheStorage
      .mockReturnValueOnce({
        ok: true,
        capacity: {
          availableBytes: 1_000_000_000_000n,
          path: "/shared",
          source: "model cache",
        },
      })
      .mockReturnValueOnce({
        ok: true,
        capacity: { availableBytes: 1n, path: "/shared", source: "model cache" },
      });

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.probeDockerStorage).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.probeDockerHostLocality).not.toHaveBeenCalled();
    expect(mocks.probeDockerBindIdentity).toHaveBeenCalledTimes(2);
    expect(mocks.probeModelCacheStorage).toHaveBeenCalledTimes(2);
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: "Docker uses a remote endpoint (ssh://builder.example.test)",
      selectorDescription: "remote DOCKER_HOST",
      selectorName: "DOCKER_HOST" as const,
      selectorValue: "ssh://builder.example.test",
    },
    {
      reason:
        "Docker uses a non-default socket (unix:///tmp/forwarded-remote.sock) whose daemon host filesystem cannot be verified",
      selectorDescription: "forwarded Unix DOCKER_HOST",
      selectorName: "DOCKER_HOST" as const,
      selectorValue: "unix:///tmp/forwarded-remote.sock",
    },
    {
      reason:
        "Docker uses a named context (remote-builder) whose host filesystem cannot be verified",
      selectorDescription: "named DOCKER_CONTEXT",
      selectorName: "DOCKER_CONTEXT" as const,
      selectorValue: "remote-builder",
    },
    {
      reason:
        "Docker client runs inside a container, so daemon bind-mount storage cannot be verified",
      selectorDescription: "default socket mounted into a client container",
      selectorName: "DOCKER_HOST" as const,
      selectorValue: "unix:///var/run/docker.sock",
    },
    {
      reason:
        "Docker daemon could not read the client storage sentinel; bind-mount filesystem identity cannot be verified",
      selectorDescription: "namespace-local PID 1 bind mismatch",
      selectorName: "DOCKER_HOST" as const,
      selectorValue: "unix:///var/run/docker.sock",
    },
  ])("blocks a cached image for an unverifiable $selectorDescription (#6757)", async ({
    reason,
    selectorName,
    selectorValue,
  }) => {
    delete process.env.DOCKER_HOST;
    delete process.env.DOCKER_CONTEXT;
    process.env[selectorName] = selectorValue;
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
    mocks.probeDockerBindIdentity.mockReturnValue({
      ok: false,
      reason,
    });

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerImageInspectFormat).toHaveBeenCalledWith(
      "{{.Id}}",
      profile.image,
      expect.objectContaining({
        env: expect.objectContaining({ [selectorName]: selectorValue }),
      }),
    );
    expect(mocks.probeDockerBindIdentity).toHaveBeenCalledWith(
      path.join(os.homedir(), ".cache", "huggingface"),
      profile.image,
    );
    expect(mocks.probeModelCacheStorage).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(reason));
  });

  it("allows the dedicated override for an unverifiable cached-image host (#6757)", async () => {
    process.env.DOCKER_HOST = "ssh://builder.example.test";
    delete process.env.DOCKER_CONTEXT;
    process.env.NEMOCLAW_IGNORE_VLLM_DISK_SPACE = "1";
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
    mocks.probeDockerBindIdentity.mockReturnValue({
      ok: false,
      reason: "Docker uses a remote endpoint (ssh://builder.example.test)",
    });

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.probeDockerBindIdentity).toHaveBeenCalledTimes(2);
    expect(mocks.probeModelCacheStorage).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.dockerSpawn).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("NEMOCLAW_IGNORE_VLLM_DISK_SPACE=1"),
    );
  });

  it("uses one Docker context throughout a successful managed install (#6757)", async () => {
    process.env.DOCKER_CONTEXT = "local-test-context";
    delete process.env.DOCKER_HOST;
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName);

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.probeDockerStorage).toHaveBeenCalledTimes(1);

    const dockerAdapterOptions = [
      ...mocks.dockerImageInspectFormat.mock.calls.map((call) => call[2]),
      ...mocks.dockerPullWithProgressWatchdog.mock.calls.map((call) => call[1]),
      ...mocks.dockerSpawn.mock.calls.map((call) => call[1]),
      ...mocks.dockerForceRm.mock.calls.map((call) => call[1]),
      ...mocks.dockerRunDetached.mock.calls.map((call) => call[1]),
      ...mocks.dockerCapture.mock.calls.map((call) => call[1]),
    ];
    expect(dockerAdapterOptions).toHaveLength(6);
    for (const options of dockerAdapterOptions) {
      expect(options).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({ DOCKER_CONTEXT: "local-test-context" }),
        }),
      );
    }
  });

  it("starts the long-lived vLLM container through Docker argv, not a shell command", async () => {
    process.env.HF_TOKEN = "hf_test";
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.dockerForceRm).toHaveBeenCalledWith(
      profile.containerName,
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(mocks.dockerRunDetached).toHaveBeenCalledTimes(1);
    const [args, opts] = mocks.dockerRunDetached.mock.calls[0] as [
      string[],
      { env?: Record<string, string> },
    ];
    expect(args).toEqual(
      expect.arrayContaining([
        "--pull=never",
        "--restart",
        "unless-stopped",
        "-e",
        "HF_TOKEN",
        profile.image,
      ]),
    );
    expect(args.join(" ")).not.toContain("hf_test");
    expect(args.some((arg) => arg.includes("docker run"))).toBe(false);
    expect(args[args.indexOf("-lc") + 1]).toContain("vllm serve");
    expect(opts).toEqual(
      expect.objectContaining({ env: expect.objectContaining({ HF_TOKEN: "hf_test" }) }),
    );
  });

  it("rejects invalid profile run flags before launching the long-lived container", async () => {
    const baseProfile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const profile = {
      ...baseProfile,
      buildDockerRunFlags: () => ["--label", ""],
    };
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerForceRm).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("vLLM docker run flags[1] must not be empty"),
    );
  });
});
