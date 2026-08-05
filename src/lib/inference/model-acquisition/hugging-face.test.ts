// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerSpawn: vi.fn(),
}));

import {
  acquireHuggingFaceModel,
  buildHfTokenDockerArgs,
  buildHfTokenForwardEnv,
  buildHuggingFaceModelDownloadArgv,
  type HuggingFaceModelAcquisitionObserver,
  type HuggingFaceModelAcquisitionRequest,
  hfDownloadAuthentication,
} from "./hugging-face";

interface MockProcess extends EventEmitter {
  readonly stderr: EventEmitter;
  readonly stdout: EventEmitter;
}

function mockProcess(): MockProcess {
  const proc = new EventEmitter() as MockProcess;
  Object.defineProperties(proc, {
    stderr: { value: new EventEmitter() },
    stdout: { value: new EventEmitter() },
  });
  return proc;
}

function request(
  overrides: Partial<HuggingFaceModelAcquisitionRequest> = {},
): HuggingFaceModelAcquisitionRequest {
  return {
    credentialEnv: { HF_TOKEN: "hf_test_token" },
    dockerEnv: { DOCKER_HOST: "ssh://spark.example.test" },
    downloaderImage: `nvcr.io/nvidia/vllm@sha256:${"a".repeat(64)}`,
    hostCacheDir: "/home/nvidia/.cache/huggingface",
    repository: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF",
    revision: "0123456789abcdef0123456789abcdef01234567",
    spawnDocker: mocks.dockerSpawn,
    userIdentity: "1001:1001",
    ...overrides,
  };
}

function observer(): HuggingFaceModelAcquisitionObserver {
  return { logLine: vi.fn(), onRateLimit: vi.fn() };
}

describe("Hugging Face model acquisition", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    vi.useRealTimers();
  });

  it("builds the existing cache, identity, token, and revision contract with one exact file (#8279)", () => {
    const input = request({ filename: "model/Nemotron.Q4_K_M.gguf" });

    expect(buildHuggingFaceModelDownloadArgv(input)).toEqual([
      "run",
      "-t",
      "--rm",
      "--pull=never",
      "--user",
      "1001:1001",
      "--entrypoint",
      "hf",
      "-v",
      "/home/nvidia/.cache/huggingface:/tmp/nemoclaw-huggingface",
      "-e",
      "HF_HOME=/tmp/nemoclaw-huggingface",
      "-e",
      "HF_TOKEN",
      input.downloaderImage,
      "download",
      input.repository,
      "model/Nemotron.Q4_K_M.gguf",
      "--revision",
      input.revision,
    ]);
  });

  it("preserves whole-repository anonymous downloads without revision or host identity (#8279)", () => {
    const input = request({
      credentialEnv: {},
      revision: undefined,
      userIdentity: null,
    });

    expect(buildHuggingFaceModelDownloadArgv(input)).toEqual([
      "run",
      "-t",
      "--rm",
      "--pull=never",
      "--entrypoint",
      "hf",
      "-v",
      "/home/nvidia/.cache/huggingface:/tmp/nemoclaw-huggingface",
      "-e",
      "HF_HOME=/tmp/nemoclaw-huggingface",
      input.downloaderImage,
      "download",
      input.repository,
    ]);
  });

  it.each([
    "",
    "../model.gguf",
    "/model.gguf",
    "--revision",
    "model/../other.gguf",
  ])("rejects an exact filename that is not a normalized repository-relative path %j (#8279)", (filename) => {
    expect(() => buildHuggingFaceModelDownloadArgv(request({ filename }))).toThrow(
      "Hugging Face filename must be one normalized repository-relative path",
    );
  });

  it("rejects a cache path that is not normalized before starting Docker (#8279)", () => {
    expect(() =>
      buildHuggingFaceModelDownloadArgv(request({ hostCacheDir: "/cache/../foreign" })),
    ).toThrow("Hugging Face cache must be a normalized absolute path");
  });

  it("rejects a root download identity before starting Docker (#8279)", () => {
    expect(() => buildHuggingFaceModelDownloadArgv(request({ userIdentity: "0:0" }))).toThrow(
      "Hugging Face model download user must be one non-root numeric uid and numeric gid",
    );
  });

  it("forwards the token by key outside argv and reports completion (#8279)", async () => {
    const proc = mockProcess();
    mocks.dockerSpawn.mockReturnValue(proc);
    const input = request();
    const events = observer();
    const resultPromise = acquireHuggingFaceModel(input, events);
    proc.emit("exit", 0);

    await expect(resultPromise).resolves.toEqual({ ok: true });
    const [argv, options] = mocks.dockerSpawn.mock.calls[0] as [
      string[],
      { env: Record<string, string>; stdio: string[] },
    ];
    expect(argv).toContain("HF_TOKEN");
    expect(argv.join("\n")).not.toContain("hf_test_token");
    expect(options).toEqual({
      env: {
        DOCKER_HOST: "ssh://spark.example.test",
        HF_TOKEN: "hf_test_token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(events.logLine).toHaveBeenNthCalledWith(
      1,
      `Pre-downloading model with hf: ${input.repository}`,
    );
    expect(events.logLine).toHaveBeenNthCalledWith(2, "Model download complete");
  });

  it("redacts a token split across UTF-8 output chunks and detects rate limiting (#8279)", async () => {
    const token = `hf_${"r".repeat(32)}`;
    const proc = mockProcess();
    mocks.dockerSpawn.mockReturnValue(proc);
    const events = observer();
    const resultPromise = acquireHuggingFaceModel(
      request({ credentialEnv: { HF_TOKEN: token } }),
      events,
    );
    const unicode = Buffer.from("Downloading café\n");
    const unicodeSplit = unicode.indexOf(0xc3) + 1;
    const tokenSplit = 17;
    proc.stdout.emit("data", unicode.subarray(0, unicodeSplit));
    proc.stdout.emit("data", unicode.subarray(unicodeSplit));
    proc.stdout.emit("data", Buffer.from(`value=${token.slice(0, tokenSplit)}`));
    proc.stderr.emit(
      "data",
      Buffer.from(`${token.slice(tokenSplit)} HTTP 429 Too Many Requests\n`),
    );
    proc.stdout.emit("data", Buffer.from("\n"));
    proc.emit("exit", 1);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: "hf download failed (exit 1)",
    });
    const stdout = stdoutWrite.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    const stderr = stderrWrite.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(`${stdout}\n${stderr}`).not.toContain(token);
    expect(`${stdout}\n${stderr}`).not.toContain(token.slice(0, tokenSplit));
    expect(`${stdout}\n${stderr}`).not.toContain(token.slice(tokenSplit));
    expect(stdout).toContain("Downloading café");
    expect(stdout).toContain("value=<REDACTED>");
    expect(stderr).toContain("HTTP 429 Too Many Requests");
    expect(`${stdout}\n${stderr}`).not.toContain("�");
    expect(events.onRateLimit).toHaveBeenCalledOnce();
  });

  it("returns one spawn error and clears the download heartbeat (#8279)", async () => {
    vi.useFakeTimers();
    const proc = mockProcess();
    mocks.dockerSpawn.mockReturnValue(proc);
    const events = observer();
    const resultPromise = acquireHuggingFaceModel(request(), events);
    proc.emit("error", new Error("docker unavailable"));
    proc.emit("exit", 125);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: "spawn error: docker unavailable",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.logLine).toHaveBeenCalledTimes(1);
  });

  it("keeps token selection and metadata behavior independent of the serving provider (#8279)", () => {
    const env = {
      HF_TOKEN: "hf_primary",
      HUGGING_FACE_HUB_TOKEN: "hf_secondary",
    } as NodeJS.ProcessEnv;
    expect(buildHfTokenDockerArgs(env)).toEqual(["-e", "HF_TOKEN"]);
    expect(buildHfTokenForwardEnv(env)).toEqual({ HF_TOKEN: "hf_primary" });
    expect(hfDownloadAuthentication(env)).toEqual({
      authenticated: true,
      source: "HF_TOKEN",
    });
    expect(
      hfDownloadAuthentication({ HF_TOKEN: " ", HUGGING_FACE_HUB_TOKEN: "hf_fallback" }),
    ).toEqual({ authenticated: true, source: "HUGGING_FACE_HUB_TOKEN" });
    expect(hfDownloadAuthentication({})).toEqual({ authenticated: false });
  });
});
