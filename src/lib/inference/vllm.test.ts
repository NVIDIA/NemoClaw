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
  assertVllmRegistryDigestRef,
  buildVllmRunArgs,
  detectVllmProfile,
  installVllm,
  isNemoClawManagedVllmRunning,
  NEMOCLAW_VLLM_CONTAINER_NAME,
  NEMOCLAW_VLLM_MANAGED_LABEL,
  pullImage,
  resolveVllmRuntimeProfile,
  resolveVllmServedModelId,
  VLLM_IMAGES,
} from "./vllm";
import { buildVllmServeCommand, VLLM_MODELS } from "./vllm-models";

beforeEach(() => {
  mocks.dockerImageInspectFormat.mockReturnValue("");
  mocks.findUnwritableModelCachePath.mockReturnValue(null);
  mocks.getGpuIndicesByName.mockReturnValue([]);
  mocks.measureDirectorySizeBytes.mockReturnValue(0n);
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
});

function currentHostIdentity(): string | null {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || gid === undefined ? null : `${String(uid)}:${String(gid)}`;
}

function inconclusiveModelStorage(reason = "statfs unavailable") {
  return {
    ok: false as const,
    reason,
    path: path.join(os.homedir(), ".cache", "huggingface"),
    source: "Hugging Face cache",
  };
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

describe("managed vLLM image distribution boundary", () => {
  const digest = `sha256:${"a".repeat(64)}`;

  it("accepts repository-qualified immutable registry digests", () => {
    expect(() => assertVllmRegistryDigestRef(`vllm/vllm-openai@${digest}`)).not.toThrow();
    expect(() =>
      assertVllmRegistryDigestRef(`registry.example.test:5000/team/runtime@${digest}`),
    ).not.toThrow();
  });

  it.each([
    `sha256:${"a".repeat(64)}`,
    "vllm/vllm-openai:latest",
    `ubuntu@${digest}`,
    `vllm/vllm-openai@sha256:${"A".repeat(64)}`,
    `vllm/vllm-openai@${digest}suffix`,
    ` vllm/vllm-openai@${digest}`,
    `vllm/vllm-openai@${digest} `,
  ])("rejects an unpullable or mutable product image reference %j", (image) => {
    expect(() => assertVllmRegistryDigestRef(image)).toThrow(
      /pullable immutable registry reference/,
    );
  });

  it("keeps every shipped managed-vLLM image on a registry digest", () => {
    const platformRefs = Object.values(VLLM_IMAGES).flatMap((imageSet) =>
      Object.values(imageSet)
        .map((value) =>
          typeof value === "object" && value !== null && "ref" in value ? String(value.ref) : null,
        )
        .filter((ref): ref is string => ref !== null),
    );
    const runtimeRefs = VLLM_MODELS.map((model) => model.runtime?.image).filter(
      (ref): ref is string => typeof ref === "string",
    );
    const refs = new Set([...platformRefs, ...runtimeRefs]);

    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(() => assertVllmRegistryDigestRef(ref), ref).not.toThrow();
    }
  });

  it("refuses a local image ID before invoking Docker pull", async () => {
    mocks.dockerPullWithProgressWatchdog.mockClear();
    const profile = {
      ...detectVllmProfile({ platform: "station", type: "nvidia" })!,
      image: `sha256:${"a".repeat(64)}`,
    };

    await expect(pullImage(profile)).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("Local image IDs"),
    });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
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
    expect(profile!.imageUnpackedSizeBytes).toBe(27_658_526_720);
    expect(profile!.defaultModel.id).toBe("deepseek-ai/DeepSeek-V4-Flash");
    expect(profile!.defaultModel.envValue).toBe("deepseek-v4-flash");
  });

  it("resolves Nemotron Ultra to the pinned Station runtime on the bridge network", () => {
    mocks.getGpuIndicesByName.mockReturnValue([0]);
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });
    const ultra = VLLM_MODELS.find((model) => model.envValue === "nemotron-3-ultra-550b-a55b");

    expect(profile).not.toBeNull();
    expect(ultra).toBeDefined();
    const runtime = resolveVllmRuntimeProfile(profile!, ultra!);
    expect(runtime.image).toBe(
      "vllm/vllm-openai@sha256:0fec7ec5f3e6bc168e54899935fb0557da908a4832a1dbc88e2debcf2f889416",
    );
    expect(runtime.imageDownloadSizeBytes).toBe(10_670_087_425);
    expect(runtime.imageUnpackedSizeBytes).toBeUndefined();
    expect(runtime.modelDownloadSizeBytes).toBe(352_381_245_521);
    expect(runtime.loadTimeoutSec).toBe(3600);
    expect(runtime.buildDockerRunFlags!()).toEqual(
      expect.arrayContaining(["--gpus", "device=0", "--shm-size", "16g"]),
    );

    const flags = runtime.buildDockerRunFlags!();
    const args = buildVllmRunArgs(runtime, ultra!, flags, {} as NodeJS.ProcessEnv);
    expect(args).toEqual([
      "--pull=never",
      "--restart",
      "unless-stopped",
      "--gpus",
      "device=0",
      "--ipc=host",
      "-v",
      `${path.join(os.homedir(), ".cache", "huggingface")}:/root/.cache/huggingface`,
      "-e",
      "HF_HOME=/root/.cache/huggingface",
      "--shm-size",
      "16g",
      "--ulimit",
      "memlock=-1",
      "--ulimit",
      "stack=67108864",
      "--label",
      `${NEMOCLAW_VLLM_MANAGED_LABEL}=true`,
      "-p",
      "8000:8000",
      "--name",
      NEMOCLAW_VLLM_CONTAINER_NAME,
      "--entrypoint",
      "/bin/bash",
      runtime.image,
      "-lc",
      buildVllmServeCommand(ultra!, {} as NodeJS.ProcessEnv),
    ]);
  });

  it("keeps DGX Spark on the Qwen3.6 35B NVFP4 default", () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" });

    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("DGX Spark");
    expect(profile!.image).toBe(
      "nvcr.io/nvidia/vllm@sha256:9204569b17ee4c0eff75194b8e6e458479c8aee18953b5ab9cf359fcdac659e2",
    );
    expect(profile!.imageDownloadSizeBytes).toBe(9_603_085_145);
    expect(profile!.imageUnpackedSizeBytes).toBe(27_658_526_720);
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

    expect(args).toEqual(expect.arrayContaining(["--label", labelValue]));
    expect(args).not.toContain(`--label ${labelValue}`);
    expect(args).not.toContain("-e HF_TOKEN");
    expect(args).not.toContain("HF_TOKEN");
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
  let mkdirSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
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
    mkdirSpy.mockRestore();
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

  it("rejects a local image ID before callbacks, prompts, or Docker work", async () => {
    const profile = {
      ...detectVllmProfile({ platform: "station", type: "nvidia" })!,
      image: `sha256:${"a".repeat(64)}`,
    };
    const promptFn = vi.fn<(q: string) => Promise<string>>();
    const beforeInstall = vi.fn();

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn,
      beforeInstall,
    });

    expect(result).toEqual({ ok: false });
    expect(promptFn).not.toHaveBeenCalled();
    expect(beforeInstall).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Local image IDs"));
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

  it("rejects a Station-only runtime override before side effects on generic Linux", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "nemotron-3-ultra-550b-a55b";
    const profile = detectVllmProfile({ platform: "linux", type: "nvidia" })!;
    const beforeInstall = vi.fn();

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
      beforeInstall,
    });

    expect(result).toEqual({ ok: false });
    expect(beforeInstall).not.toHaveBeenCalled();
    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(errors).toContain(
      "NVIDIA Nemotron 3 Ultra 550B NVFP4 is not supported on Linux + NVIDIA GPU",
    );
  });

  it("installs the complete Nemotron Ultra Station recipe without another selection", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "nemotron-3-ultra-550b-a55b";
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    const beforeInstall = vi.fn();
    const promptFn = vi.fn<(q: string) => Promise<string>>();
    mockSuccessfulVllmInstall(profile.containerName);

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn,
      beforeInstall,
    });

    expect(result).toEqual({ ok: true });
    expect(promptFn).not.toHaveBeenCalled();
    expect(beforeInstall).toHaveBeenCalledWith("nvidia/nemotron-3-ultra-550b-a55b");
    expect(mocks.measureDirectorySizeBytes).toHaveBeenCalledWith(
      path.join(
        os.homedir(),
        ".cache",
        "huggingface",
        "hub",
        "models--nvidia--NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
        "snapshots",
        "183968f87ae4cedce3039313cac1fd43d112c578",
      ),
    );
    expect(mocks.probeHostStorage).toHaveBeenCalledWith(
      path.join(os.homedir(), ".cache", "huggingface"),
      "Hugging Face cache",
    );
    expect(mocks.probeHostStorage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dockerPullWithProgressWatchdog.mock.invocationCallOrder[0],
    );
    expect(mocks.probeHostStorage).toHaveBeenCalledTimes(2);
    expect(mocks.dockerPullWithProgressWatchdog.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.probeHostStorage.mock.invocationCallOrder[1],
    );
    expect(mocks.probeHostStorage.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.dockerSpawn.mock.invocationCallOrder[0],
    );
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledWith(
      "vllm/vllm-openai@sha256:0fec7ec5f3e6bc168e54899935fb0557da908a4832a1dbc88e2debcf2f889416",
      expect.any(Object),
    );
    const [downloadArgs] = mocks.dockerSpawn.mock.calls[0] as [string[]];
    expect(downloadArgs).toEqual(
      expect.arrayContaining([
        "-v",
        `${path.join(os.homedir(), ".cache", "huggingface")}:/tmp/nemoclaw-huggingface`,
        "-e",
        "HF_HOME=/tmp/nemoclaw-huggingface",
        "download",
        "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
        "--revision",
        "183968f87ae4cedce3039313cac1fd43d112c578",
      ]),
    );
    const hostIdentity = currentHostIdentity();
    expect(downloadArgs.includes("--user")).toBe(hostIdentity !== null);
    expect(downloadArgs).toEqual(
      expect.arrayContaining(hostIdentity === null ? [] : ["--user", hostIdentity]),
    );
    expect(mkdirSpy).toHaveBeenCalledWith(path.join(os.homedir(), ".cache", "huggingface"), {
      recursive: true,
    });
    const [runArgs] = mocks.dockerRunDetached.mock.calls[0] as [string[]];
    expect(runArgs).toEqual(expect.arrayContaining(["--shm-size", "16g", "-p", "8000:8000"]));
    expect(runArgs).not.toContain("--network");
    expect(runArgs.at(-1)).toContain("--cpu-offload-gb 150");
    expect(runArgs.at(-1)).toContain("--reasoning-parser nemotron_v3");
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

  it("fails before image pull when the host Hugging Face cache cannot be created", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName);
    mkdirSpy.mockImplementation(() => {
      throw new Error("permission denied");
    });

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not create Hugging Face cache directory"),
    );
  });

  it("fails before image pull with a safe repair command for a root-owned cache", async () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:cached-image");
    const cacheDir = path.join(os.homedir(), ".cache", "huggingface");
    const rootOwnedPath = path.join(
      cacheDir,
      "hub",
      "models--nvidia--Qwen3.6-35B-A3B-NVFP4",
      ".no_exist",
      "processor_config.json",
    );
    mocks.findUnwritableModelCachePath.mockReturnValue(rootOwnedPath);

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    const [scopedCacheDir, scopedModelDir] = mocks.findUnwritableModelCachePath.mock.calls[0];
    expect(scopedCacheDir).toBe(cacheDir);
    expect(scopedModelDir).toBe(
      path.join(cacheDir, "hub", "models--nvidia--Qwen3.6-35B-A3B-NVFP4"),
    );
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain(rootOwnedPath);
    expect(errors).toContain("not writable by host user");
    expect(errors).toContain("NemoClaw did not modify it");
    expect(errors).toContain("sudo chown -R");
    expect(errors).toContain(`'${rootOwnedPath}'`);
    expect(errors).toContain(currentHostIdentity() ?? "$(id -u):$(id -g)");
  });

  it("limits the Hugging Face token to the one-shot download container", async () => {
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
    const [downloadArgs, downloadOpts] = mocks.dockerSpawn.mock.calls[0] as [
      string[],
      { env?: Record<string, string> },
    ];
    expect(downloadArgs).toEqual(expect.arrayContaining(["-e", "HF_TOKEN"]));
    expect(downloadArgs.join(" ")).not.toContain("hf_test");
    expect(downloadOpts).toEqual(
      expect.objectContaining({ env: expect.objectContaining({ HF_TOKEN: "hf_test" }) }),
    );
    expect(mocks.dockerRunDetached).toHaveBeenCalledTimes(1);
    const [args, opts] = mocks.dockerRunDetached.mock.calls[0] as [
      string[],
      { env?: Record<string, string> },
    ];
    expect(args).toEqual(
      expect.arrayContaining(["--pull=never", "--restart", "unless-stopped", profile.image]),
    );
    expect(args).not.toContain("HF_TOKEN");
    expect(args.join(" ")).not.toContain("hf_test");
    expect(args.some((arg) => arg.includes("docker run"))).toBe(false);
    expect(args[args.indexOf("-lc") + 1]).toContain("vllm serve");
    expect(opts.env).not.toHaveProperty("HF_TOKEN");
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
