// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerCapture: vi.fn(),
  dockerPullWithProgressWatchdog: vi.fn(),
  dockerSpawn: vi.fn(),
  getGpuIndicesByName: vi.fn(() => []),
  runCapture: vi.fn(),
  runShell: vi.fn(),
}));

vi.mock("../runner", () => ({
  runCapture: mocks.runCapture,
  runShell: mocks.runShell,
}));

vi.mock("../adapters/docker", () => ({
  dockerCapture: mocks.dockerCapture,
  dockerPullWithProgressWatchdog: mocks.dockerPullWithProgressWatchdog,
  dockerSpawn: mocks.dockerSpawn,
}));

vi.mock("./nim", () => ({
  getGpuIndicesByName: mocks.getGpuIndicesByName,
}));

import { buildVllmRunCommand, detectVllmProfile, installVllm, pullImage } from "./vllm";

describe("vLLM profile detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses Qwen3.6 27B and the 26.05.post1 NGC image on DGX Station", () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("DGX Station");
    expect(profile!.image).toBe("nvcr.io/nvidia/vllm:26.05.post1-py3");
    expect(profile!.defaultModel.id).toBe("Qwen/Qwen3.6-27B-FP8");
    expect(profile!.defaultModel.envValue).toBe("qwen3.6-27b");
  });

  it("keeps DGX Spark on the Qwen3.6 35B NVFP4 default", () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" });

    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("DGX Spark");
    expect(profile!.image).toBe("nvcr.io/nvidia/vllm:26.05.post1-py3");
    expect(profile!.defaultModel.id).toBe("nvidia/Qwen3.6-35B-A3B-NVFP4");
    expect(profile!.defaultModel.envValue).toBe("qwen3.6-35b-a3b-nvfp4");
  });

  it("keeps generic Linux on the smaller Nemotron Nano default", () => {
    const profile = detectVllmProfile({ platform: "linux", type: "nvidia" });

    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("Linux + NVIDIA GPU");
    expect(profile!.image).toBe("nvcr.io/nvidia/vllm:26.03.post1-py3");
    expect(profile!.defaultModel.id).toBe("nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8");
    expect(profile!.defaultModel.envValue).toBe("nemotron-3-nano-4b");
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

    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledWith(profile!.image, {
      maxTimeoutMs: profile!.pullTimeoutSec * 1000,
      logLine: expect.any(Function),
    });
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
    const cmd = buildVllmRunCommand(
      profile!,
      profile!.defaultModel,
      profile!.dockerRunFlags.join(" "),
    );
    expect(cmd).toContain("docker run -d --restart unless-stopped");
    expect(cmd).toContain(`--name ${profile!.containerName}`);
    expect(cmd).toContain(":8000");
  });

  it("preserves the profile run flags and image", () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });
    expect(profile).not.toBeNull();
    const cmd = buildVllmRunCommand(profile!, profile!.defaultModel, "--gpus device=0 --ipc=host");
    expect(cmd).toContain("--restart unless-stopped --gpus device=0 --ipc=host");
    expect(cmd).toContain(profile!.image);
    expect(cmd).toContain("--entrypoint /bin/bash");
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
});
