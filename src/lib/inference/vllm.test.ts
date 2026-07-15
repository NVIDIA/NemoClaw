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
  probeDockerStorage: vi.fn(),
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
    probeDockerStorage: mocks.probeDockerStorage,
  };
});

import {
  buildVllmRunArgs,
  detectVllmProfile,
  installVllm,
  isNemoClawManagedVllmRunning,
  NEMOCLAW_VLLM_CONTAINER_NAME,
  NEMOCLAW_VLLM_MANAGED_LABEL,
  pullImage,
  resolveVllmServedModelId,
} from "./vllm";

beforeEach(() => {
  mocks.dockerImageInspectFormat.mockReturnValue("");
  mocks.probeDockerStorage.mockReturnValue({
    ok: true,
    capacity: { availableBytes: 1_000_000_000_000n, path: "/docker", source: "Docker" },
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

const MANAGED_CONTAINER_ID = "a".repeat(64);

function vllmContainerRow(
  containerName: string,
  { id = MANAGED_CONTAINER_ID, label = "true", state = "exited" } = {},
): string {
  return `${id}|${containerName}|${state}|${label}`;
}

function mockSuccessfulVllmInstall(
  containerName: string,
  ownershipResponses: readonly (() => string)[] = [() => "", () => ""],
): void {
  const runCaptureByCommand: Record<string, string> = {
    curl: '{"data":[]}',
    sh: "/usr/bin/tool\n",
  };
  mocks.runCapture.mockImplementation(
    (cmd: readonly string[]) => runCaptureByCommand[cmd[0] ?? ""] ?? "",
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
  const ownershipQueue = [...ownershipResponses];
  const dockerCaptureByCommand = new Map<string, () => string>([
    ["container", () => (ownershipQueue.shift() ?? (() => ""))()],
    ["ps", () => `${containerName}\n`],
  ]);
  mocks.dockerCapture.mockImplementation((args: readonly string[]) =>
    (dockerCaptureByCommand.get(args[0] ?? "") ?? (() => ""))(),
  );
}

function mockInconclusiveDockerStorage(): void {
  mocks.probeDockerStorage.mockReturnValue({
    ok: false,
    reason: "Docker uses a remote endpoint (ssh://builder.example.test)",
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
    expect(profile!.imageDownloadSizeBytes).toBe(9_603_085_145);
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
    expect(args).toEqual(
      expect.arrayContaining(["--label", `${NEMOCLAW_VLLM_MANAGED_LABEL}=true`]),
    );
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

describe("managed vLLM ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recognizes only the exact running container with the managed label", () => {
    mocks.dockerCapture.mockReturnValue(
      vllmContainerRow(NEMOCLAW_VLLM_CONTAINER_NAME, { state: "running" }),
    );

    expect(isNemoClawManagedVllmRunning()).toBe(true);
    expect(mocks.dockerCapture).toHaveBeenCalledWith(
      [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `name=^/${NEMOCLAW_VLLM_CONTAINER_NAME}$`,
        "--format",
        `{{.ID}}|{{.Names}}|{{.State}}|{{.Label "${NEMOCLAW_VLLM_MANAGED_LABEL}"}}`,
      ],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it.each([
    vllmContainerRow(NEMOCLAW_VLLM_CONTAINER_NAME),
    vllmContainerRow(NEMOCLAW_VLLM_CONTAINER_NAME, { label: "" }),
    vllmContainerRow(NEMOCLAW_VLLM_CONTAINER_NAME, { label: "false", state: "running" }),
    "",
    "malformed",
    `${vllmContainerRow(NEMOCLAW_VLLM_CONTAINER_NAME)}\n${vllmContainerRow(NEMOCLAW_VLLM_CONTAINER_NAME)}`,
  ])("fails closed for inspect output %j", (output) => {
    mocks.dockerCapture.mockReturnValue(output);
    expect(isNemoClawManagedVllmRunning()).toBe(false);
  });

  it("fails closed when Docker inspection throws", () => {
    mocks.dockerCapture.mockImplementation(() => {
      throw new Error("docker unavailable");
    });
    expect(isNemoClawManagedVllmRunning()).toBe(false);
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

  it("reports an inconclusive capacity check without blocking the image pull (#6757)", async () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
    mockSuccessfulVllmInstall(profile.containerName);
    mockInconclusiveDockerStorage();
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
    expect(errors).toContain("Unable to verify Docker storage for the managed vLLM image");
    expect(errors).toContain("Available: unknown (");
    expect(errors).toContain("Continuing because Docker storage capacity could not be verified");
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
    expect(dockerAdapterOptions).toHaveLength(7);
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
    expect(mocks.dockerForceRm).not.toHaveBeenCalled();
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

  it("replaces only an existing managed container by its inspected ID", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const managed = vllmContainerRow(profile.containerName);
    mockSuccessfulVllmInstall(profile.containerName, [() => managed, () => managed]);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.dockerForceRm).toHaveBeenCalledWith(
      MANAGED_CONTAINER_ID,
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(mocks.dockerForceRm).not.toHaveBeenCalledWith(profile.containerName, expect.anything());
    expect(mocks.dockerRunDetached).toHaveBeenCalledTimes(1);
  });

  it.each([
    "",
    "false",
  ])("preserves a same-name container with managed label %j before downloads", async (label) => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName, [
      () => vllmContainerRow(profile.containerName, { label }),
    ]);

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerForceRm).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("NemoClaw will not remove it"));
  });

  it.each([
    [
      "Docker inspection failure",
      (): string => {
        throw new Error("docker unavailable");
      },
    ],
    ["malformed ownership output", (): string => "malformed"],
  ] as const)("fails closed on %s", async (_name, ownershipResponse) => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName, [ownershipResponse]);

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerForceRm).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not verify ownership of Docker container"),
    );
  });

  it("rechecks ownership after downloads and preserves a replacement container", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName, [
      () => vllmContainerRow(profile.containerName),
      () => vllmContainerRow(profile.containerName, { label: "" }),
    ]);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.dockerSpawn).toHaveBeenCalledTimes(1);
    expect(mocks.dockerForceRm).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("NemoClaw will not remove it"));
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
