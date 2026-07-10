// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerCapture: vi.fn(),
  dockerForceRm: vi.fn(),
  dockerPullWithProgressWatchdog: vi.fn(),
  dockerRunDetached: vi.fn(),
  dockerSpawn: vi.fn(),
  dockerStop: vi.fn(),
  getGpuIndicesByName: vi.fn<(_pattern: RegExp) => number[]>(() => []),
  runCapture: vi.fn(),
}));

vi.mock("../runner", () => ({
  runCapture: mocks.runCapture,
}));

vi.mock("../adapters/docker", () => ({
  dockerCapture: mocks.dockerCapture,
  dockerForceRm: mocks.dockerForceRm,
  dockerPullWithProgressWatchdog: mocks.dockerPullWithProgressWatchdog,
  dockerRunDetached: mocks.dockerRunDetached,
  dockerSpawn: mocks.dockerSpawn,
  dockerStop: mocks.dockerStop,
}));

vi.mock("./nim", () => ({
  getGpuIndicesByName: mocks.getGpuIndicesByName,
}));

import {
  buildVllmRunArgs,
  detectVllmProfile,
  installVllm,
  pullImage,
  resolveVllmServedModelId,
} from "./vllm";

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
    expect(profile!.image).toBe("nvcr.io/nvidia/vllm:26.05.post1-py3");
    expect(profile!.defaultModel.id).toBe("deepseek-ai/DeepSeek-V4-Flash");
    expect(profile!.defaultModel.envValue).toBe("deepseek-v4-flash");
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
    const args = buildVllmRunArgs(profile!, profile!.defaultModel, profile!.dockerRunFlags);
    expect(args.slice(0, 2)).toEqual(["--restart", "unless-stopped"]);
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

  it("starts the long-lived vLLM container through Docker argv, not a shell command", async () => {
    process.env.HF_TOKEN = "hf_test";
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName);

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
      expect.arrayContaining(["--restart", "unless-stopped", "-e", "HF_TOKEN", profile.image]),
    );
    expect(args.join(" ")).not.toContain("hf_test");
    expect(args.some((arg) => arg.includes("docker run"))).toBe(false);
    expect(args[args.indexOf("-lc") + 1]).toContain("vllm serve");
    expect(opts).toEqual(expect.objectContaining({ env: { HF_TOKEN: "hf_test" } }));
  });

  it("rejects invalid profile run flags before launching the long-lived container", async () => {
    const baseProfile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const profile = {
      ...baseProfile,
      buildDockerRunFlags: () => ["--label", ""],
    };
    mockSuccessfulVllmInstall(profile.containerName);

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
