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
  findUnwritableTreePath: vi.fn(),
  getGpuIndicesByName: vi.fn<(_pattern: RegExp) => number[]>(() => []),
  measureDirectorySizeBytes: vi.fn(),
  probeDockerStorage: vi.fn(),
  probeHostStorage: vi.fn(),
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
    findUnwritableTreePath: mocks.findUnwritableTreePath,
    measureDirectorySizeBytes: mocks.measureDirectorySizeBytes,
    probeDockerStorage: mocks.probeDockerStorage,
    probeHostStorage: mocks.probeHostStorage,
  };
});

import {
  buildVllmRunArgs,
  detectVllmProfile,
  installVllm,
  NEMOCLAW_VLLM_CONTAINER_NAME,
  NEMOCLAW_VLLM_MANAGED_LABEL,
  resolveVllmRuntimeProfile,
} from "./vllm";
import {
  buildVllmServeCommand,
  EXPERIMENTAL_SINGLE_USER_PROFILE,
  NEMOTRON_ULTRA_EXPERIMENTAL_SINGLE_USER_IMAGE,
  resolveVllmModelProfile,
  VLLM_MODELS,
} from "./vllm-models";

beforeEach(() => {
  mocks.dockerImageInspectFormat.mockReturnValue("");
  mocks.findUnwritableTreePath.mockReturnValue(null);
  mocks.measureDirectorySizeBytes.mockReturnValue(0n);
  mocks.probeDockerStorage.mockReturnValue({
    ok: true,
    capacity: { availableBytes: 1_000_000_000_000n, path: "/docker", source: "Docker" },
  });
  mocks.probeHostStorage.mockReturnValue({
    ok: true,
    capacity: {
      availableBytes: 1_000_000_000_000n,
      path: path.join(os.homedir(), ".cache", "huggingface"),
      source: "Hugging Face cache",
    },
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

function mockSuccessfulVllmInstall(
  containerName: string,
  endpoints: {
    healthStatus?: string;
    modelsResponse?: string;
    qualificationSamples?: readonly string[];
  } = {},
): void {
  const qualificationSamples = [...(endpoints.qualificationSamples ?? ["1000, 0, 0"])];
  let lastQualificationSample = qualificationSamples.at(-1) ?? "";
  mocks.runCapture.mockImplementation((cmd: readonly string[]) => {
    if (cmd[0] === "sh") return "/usr/bin/tool\n";
    if (cmd[0] === "nvidia-smi") {
      const sample = qualificationSamples.shift() ?? lastQualificationSample;
      lastQualificationSample = sample;
      return sample;
    }
    if (cmd[0] !== "curl") return "";
    const url = cmd.at(-1) ?? "";
    return url.endsWith("/health")
      ? (endpoints.healthStatus ?? "")
      : (endpoints.modelsResponse ?? '{"data":[]}');
  });
  mocks.dockerPullWithProgressWatchdog.mockResolvedValue({
    status: 0,
    signal: null,
    output: "",
    timedOut: false,
    timeoutKind: null,
  });
  mocks.dockerSpawn.mockReturnValue(mockDockerSpawnSuccess());
  mocks.dockerRunDetached.mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
  const ownershipResponses: (() => string)[] = [() => "", () => ""];
  mocks.dockerCapture.mockImplementation((args: readonly string[]) => {
    if (args[0] === "container") return (ownershipResponses.shift() ?? (() => ""))();
    if (args[0] === "ps") return `${containerName}\n`;
    return "";
  });
}

describe("experimental single-user vLLM runtime profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves through the existing Station runtime with exact generated Docker arguments", () => {
    mocks.getGpuIndicesByName.mockReturnValue([0]);
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });
    const ultra = VLLM_MODELS.find((model) => model.envValue === "nemotron-3-ultra-550b-a55b");

    expect(profile).not.toBeNull();
    expect(ultra).toBeDefined();
    const effective = resolveVllmModelProfile(ultra!, "station", {
      NEMOCLAW_VLLM_PROFILE: EXPERIMENTAL_SINGLE_USER_PROFILE,
    });
    const runtime = resolveVllmRuntimeProfile(profile!, effective.model);
    const flags = runtime.buildDockerRunFlags!();

    expect(runtime).toEqual(
      expect.objectContaining({
        image: NEMOTRON_ULTRA_EXPERIMENTAL_SINGLE_USER_IMAGE.localImageId,
        loadTimeoutSec: 1200,
        networkMode: "host",
        imagePullPolicy: "local-only",
        expectedImageId: NEMOTRON_ULTRA_EXPERIMENTAL_SINGLE_USER_IMAGE.localImageId,
        qualification: {
          gpuNameIncludes: "GB300",
          gpuCount: 1,
          hbmSafetyCeilingMiB: 245000,
          requireZeroUncorrectedEcc: true,
        },
      }),
    );
    expect(flags).toEqual([
      "--gpus",
      "device=0",
      "--ipc=host",
      "-v",
      `${path.join(os.homedir(), ".cache", "huggingface")}:/root/.cache/huggingface`,
      "-e",
      "HF_HOME=/root/.cache/huggingface",
      "--network",
      "host",
      "--shm-size",
      "16g",
      "--memory",
      "650g",
      "-e",
      "VLLM_WEIGHT_OFFLOADING_DISABLE_PIN_MEMORY=1",
      "-e",
      "VLLM_NVFP4_GEMM_BACKEND=flashinfer-trtllm",
      "-e",
      "NEMOTRON_ULTRA_MODEL_OPT_NVFP4_MOE_RECLAIM=1",
      "-e",
      "HF_HUB_OFFLINE=1",
      "-e",
      "TRANSFORMERS_OFFLINE=1",
      "-e",
      "PYTHONHASHSEED=0",
    ]);

    expect(buildVllmRunArgs(runtime, effective.model, flags, {} as NodeJS.ProcessEnv)).toEqual([
      "--pull=never",
      "--restart",
      "unless-stopped",
      ...flags,
      "--label",
      `${NEMOCLAW_VLLM_MANAGED_LABEL}=true`,
      "--name",
      NEMOCLAW_VLLM_CONTAINER_NAME,
      "--entrypoint",
      "/bin/bash",
      NEMOTRON_ULTRA_EXPERIMENTAL_SINGLE_USER_IMAGE.localImageId,
      "-lc",
      buildVllmServeCommand(effective.model, {} as NodeJS.ProcessEnv),
    ]);
  });
});

describe("experimental single-user vLLM install", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.env.NEMOCLAW_VLLM_MODEL = "nemotron-3-ultra-550b-a55b";
    process.env.NEMOCLAW_VLLM_PROFILE = EXPERIMENTAL_SINGLE_USER_PROFILE;
    delete process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON;
    delete process.env.NEMOCLAW_IGNORE_VLLM_DISK_SPACE;
    delete process.env.HF_TOKEN;
    delete process.env.HUGGING_FACE_HUB_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mkdirSpy.mockRestore();
    stdoutWrite.mockRestore();
    process.env = { ...originalEnv };
  });

  it("fails closed before downloads when the qualified image is absent", async () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    const beforeInstall = vi.fn();
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("");

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
      beforeInstall,
    });

    expect(result).toEqual({ ok: false });
    expect(beforeInstall).toHaveBeenCalledWith("nemotron-ultra");
    expect(mocks.probeHostStorage).not.toHaveBeenCalled();
    expect(mocks.probeDockerStorage).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(errors).toContain("qualified experimental runtime image is not published");
    expect(errors).toContain(NEMOTRON_ULTRA_EXPERIMENTAL_SINGLE_USER_IMAGE.localImageId);
    expect(errors).toContain("No fallback image was substituted");
  });

  it("runs the exact preloaded profile and validates both readiness endpoints", async () => {
    mocks.getGpuIndicesByName.mockReturnValue([0]);
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    const beforeInstall = vi.fn();
    mockSuccessfulVllmInstall(profile.containerName, {
      healthStatus: "200",
      modelsResponse: '{"data":[{"id":"nemotron-ultra","max_model_len":262144}]}',
    });
    mocks.dockerImageInspectFormat.mockReturnValue(
      NEMOTRON_ULTRA_EXPERIMENTAL_SINGLE_USER_IMAGE.localImageId,
    );

    const result = await installVllm(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: vi.fn(),
      beforeInstall,
    });

    expect(result).toEqual({ ok: true });
    expect(beforeInstall).toHaveBeenCalledWith("nemotron-ultra");
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    const curlCalls = mocks.runCapture.mock.calls
      .map((call) => call[0] as string[])
      .filter((args) => args[0] === "curl");
    expect(curlCalls.map((args) => args.at(-1))).toEqual([
      "http://127.0.0.1:8000/health",
      "http://127.0.0.1:8000/v1/models",
    ]);
    expect(curlCalls[0]).toEqual(expect.arrayContaining(["-o", "/dev/null", "-w", "%{http_code}"]));
    const telemetryCalls = mocks.runCapture.mock.calls
      .map((call) => call[0] as string[])
      .filter((args) => args[0] === "nvidia-smi");
    expect(telemetryCalls).toHaveLength(2);
    expect(telemetryCalls[0]).toEqual([
      "nvidia-smi",
      "--id=0",
      "--query-gpu=memory.used,ecc.errors.uncorrected.aggregate.total,ecc.errors.uncorrected.volatile.total",
      "--format=csv,noheader,nounits",
    ]);

    const [runArgs] = mocks.dockerRunDetached.mock.calls[0] as [string[]];
    expect(runArgs).not.toContain("-p");
    expect(runArgs).toEqual(
      expect.arrayContaining([
        "--network",
        "host",
        "--ipc=host",
        "--shm-size",
        "16g",
        "--memory",
        "650g",
        NEMOTRON_ULTRA_EXPERIMENTAL_SINGLE_USER_IMAGE.localImageId,
      ]),
    );
    const serveCommand = runArgs.at(-1) ?? "";
    expect(serveCommand).toContain(
      "vllm serve /root/.cache/huggingface/hub/models--nvidia--NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4/snapshots/183968f87ae4cedce3039313cac1fd43d112c578",
    );
    expect(serveCommand).toContain("--served-model-name nemotron-ultra");
    expect(serveCommand).not.toContain("--enable-prefix-caching");
    expect(serveCommand).not.toContain("--speculative-config");
  });

  it.each([
    ["non-200 health", "503", '{"data":[{"id":"nemotron-ultra","max_model_len":262144}]}'],
    ["wrong alias", "200", '{"data":[{"id":"other-model","max_model_len":262144}]}'],
    [
      "extra model",
      "200",
      '{"data":[{"id":"nemotron-ultra","max_model_len":262144},{"id":"other","max_model_len":262144}]}',
    ],
    ["wrong context", "200", '{"data":[{"id":"nemotron-ultra","max_model_len":131072}]}'],
    ["missing context", "200", '{"data":[{"id":"nemotron-ultra"}]}'],
    ["malformed catalog", "200", "not-json"],
  ])("does not accept readiness with %s", async (_name, healthStatus, modelsResponse) => {
    mocks.getGpuIndicesByName.mockReturnValue([0]);
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName, { healthStatus, modelsResponse });
    mocks.dockerImageInspectFormat.mockReturnValue(
      NEMOTRON_ULTRA_EXPERIMENTAL_SINGLE_USER_IMAGE.localImageId,
    );
    mocks.dockerCapture.mockImplementation(() => "");

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerRunDetached).toHaveBeenCalledTimes(1);
    expect(mocks.dockerStop).toHaveBeenCalledWith(
      profile.containerName,
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
  });

  it("rejects an image identity mismatch before storage or downloads", async () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue("sha256:not-qualified");

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.probeHostStorage).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("qualified image identity mismatch"),
    );
  });

  it("fails before downloads when the qualified Station GPU is unavailable", async () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName);
    mocks.dockerImageInspectFormat.mockReturnValue(
      NEMOTRON_ULTRA_EXPERIMENTAL_SINGLE_USER_IMAGE.localImageId,
    );
    mocks.getGpuIndicesByName.mockReturnValue([]);

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.probeHostStorage).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("requires exactly 1 GPU matching 'GB300'; detected 0"),
    );
  });

  it.each([
    ["HBM ceiling", "245000, 0, 0", "qualified HBM safety ceiling exceeded"],
    ["aggregate ECC", "1000, 1, 0", "uncorrected ECC is nonzero"],
    ["volatile ECC", "1000, 0, 1", "uncorrected ECC is nonzero"],
    ["malformed telemetry", "N/A, 0, 0", "telemetry is unavailable or malformed"],
  ])("fails before downloads when qualified %s preflight fails", async (_name, sample, message) => {
    mocks.getGpuIndicesByName.mockReturnValue([0]);
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName, { qualificationSamples: [sample] });
    mocks.dockerImageInspectFormat.mockReturnValue(
      NEMOTRON_ULTRA_EXPERIMENTAL_SINGLE_USER_IMAGE.localImageId,
    );

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.probeHostStorage).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(mocks.dockerRunDetached).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(message));
  });

  it("stops the managed container when startup HBM reaches the exclusive ceiling", async () => {
    mocks.getGpuIndicesByName.mockReturnValue([0]);
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" })!;
    mockSuccessfulVllmInstall(profile.containerName, {
      healthStatus: "200",
      modelsResponse: '{"data":[{"id":"nemotron-ultra","max_model_len":262144}]}',
      qualificationSamples: ["1000, 0, 0", "245000, 0, 0"],
    });
    mocks.dockerImageInspectFormat.mockReturnValue(
      NEMOTRON_ULTRA_EXPERIMENTAL_SINGLE_USER_IMAGE.localImageId,
    );

    const result = await installVllm(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: vi.fn(),
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.dockerRunDetached).toHaveBeenCalledTimes(1);
    expect(mocks.dockerStop).toHaveBeenCalledWith(
      profile.containerName,
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("qualified HBM safety ceiling exceeded"),
    );
  });
});
