// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireHuggingFaceModel,
  buildHfTokenDockerArgs,
  buildHfTokenForwardEnv,
  buildHuggingFaceModelDownloadArgv,
  type HuggingFaceModelAcquisitionObserver,
  type HuggingFaceModelAcquisitionRequest,
  hfDownloadAuthentication,
} from "./hugging-face";

const dockerSpawn = vi.fn();

interface MockProcess extends EventEmitter {
  readonly stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  readonly stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  readonly kill: ReturnType<typeof vi.fn>;
  readonly unref: ReturnType<typeof vi.fn>;
}

function mockProcess(): MockProcess {
  const proc = new EventEmitter() as MockProcess;
  const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  Object.defineProperties(proc, {
    stderr: { value: stderr },
    stdout: { value: stdout },
    kill: { value: vi.fn(() => true) },
    unref: { value: vi.fn() },
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
    spawnDocker: dockerSpawn,
    userIdentity: "1001:1001",
    ...overrides,
  };
}

function observer(): HuggingFaceModelAcquisitionObserver {
  return { logLine: vi.fn(), onRateLimit: vi.fn() };
}

function forcedRemoveCall(): ReturnType<typeof dockerSpawn>["mock"]["calls"][number] {
  const call = dockerSpawn.mock.calls.find(([args]) =>
    Array.isArray(args) && args[0] === "rm" && args[1] === "--force",
  );
  expect(call).toBeDefined();
  return call as ReturnType<typeof dockerSpawn>["mock"]["calls"][number];
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

  it.each([
    "",
    "--revision",
    " nvidia/model",
    "nvidia/model ",
    "nvidia/bad model",
    "nvidia/model/extra",
    "nvidia/bad..model",
    "nvidia/model.git",
    `nvidia/${"a".repeat(90)}`,
    "nvidia/\u001b[31mmodel",
  ])("rejects an invalid Hugging Face repository ID %j (#8279)", (repository) => {
    expect(() => buildHuggingFaceModelDownloadArgv(request({ repository }))).toThrow(
      "Hugging Face repository must be one valid repository ID",
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
    dockerSpawn.mockReturnValue(proc);
    const input = request();
    const events = observer();
    const resultPromise = acquireHuggingFaceModel(input, events);
    proc.emit("exit", 0);

    await expect(resultPromise).resolves.toEqual({ ok: true });
    const [argv, options] = dockerSpawn.mock.calls[0] as [
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
    dockerSpawn.mockReturnValue(proc);
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

  it("redacts a contextual bearer credential split across same-stream chunks (#8279)", async () => {
    const secret = "opaque-bearer-value";
    const proc = mockProcess();
    dockerSpawn.mockReturnValue(proc);
    const resultPromise = acquireHuggingFaceModel(request({ credentialEnv: {} }), observer());
    proc.stdout.emit("data", Buffer.from("Authorization: Bearer "));
    proc.stdout.emit("data", Buffer.from(`${secret} request failed\n`));
    proc.emit("exit", 1);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: "hf download failed (exit 1)",
    });
    const output = stdoutWrite.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(output).toContain("Authorization: Bearer <REDACTED> request failed");
    expect(output).not.toContain(secret);
  });

  it("redacts a contextual bearer credential across interleaved streams (#8279)", async () => {
    const secret = "opaque-bearer-value";
    const proc = mockProcess();
    dockerSpawn.mockReturnValue(proc);
    const resultPromise = acquireHuggingFaceModel(request({ credentialEnv: {} }), observer());
    proc.stdout.emit("data", Buffer.from("Authorization: Bearer "));
    proc.stderr.emit("data", Buffer.from("progress\n"));
    proc.stdout.emit("data", Buffer.from(`${secret} request failed\n`));
    proc.emit("exit", 1);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: "hf download failed (exit 1)",
    });
    const output = [...stdoutWrite.mock.calls, ...stderrWrite.mock.calls]
      .map((call: unknown[]) => String(call[0]))
      .join("");
    expect(output).toContain("Authorization: Bearer <REDACTED> request failed");
    expect(output).toContain("progress");
    expect(output).not.toContain(secret);
  });

  it("redacts a folded authorization value across a split CRLF boundary (#8279)", async () => {
    const secret = "opaque-folded-value";
    const proc = mockProcess();
    dockerSpawn.mockReturnValue(proc);
    const resultPromise = acquireHuggingFaceModel(request({ credentialEnv: {} }), observer());
    proc.stdout.emit("data", Buffer.from("error: Authorization:\r"));
    proc.stdout.emit("data", Buffer.from("\n"));
    proc.stdout.emit("data", Buffer.from(`\t${secret}\r`));
    const progressFrameOutput = stdoutWrite.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join("");
    expect(progressFrameOutput).not.toContain(secret);
    proc.stdout.emit("data", Buffer.from("\nnext diagnostic\n"));
    proc.emit("exit", 1);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: "hf download failed (exit 1)",
    });
    const output = [...stdoutWrite.mock.calls, ...stderrWrite.mock.calls]
      .map((call: unknown[]) => String(call[0]))
      .join("");
    expect(output).toContain("Authorization: <REDACTED>");
    expect(output).toContain("next diagnostic");
    expect(output).not.toContain(secret);
  });

  it("flushes carriage-return progress frames promptly (#8279)", async () => {
    const proc = mockProcess();
    dockerSpawn.mockReturnValue(proc);
    const resultPromise = acquireHuggingFaceModel(request({ credentialEnv: {} }), observer());
    proc.stdout.emit("data", Buffer.from("Downloading 1%\r"));
    const progressOutput = stdoutWrite.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join("");
    expect(progressOutput).toContain("Downloading 1%\r");
    proc.emit("exit", 0);

    await expect(resultPromise).resolves.toEqual({ ok: true });
  });

  it("bounds unterminated output by suppressing the affected stream (#8279)", async () => {
    const proc = mockProcess();
    dockerSpawn.mockReturnValue(proc);
    const events = observer();
    const resultPromise = acquireHuggingFaceModel(request({ credentialEnv: {} }), events);
    proc.stdout.emit("data", Buffer.from("x".repeat(70_000)));
    proc.stdout.emit("data", Buffer.from("must-not-be-emitted\n"));
    proc.emit("exit", 0);

    await expect(resultPromise).resolves.toEqual({ ok: true });
    const output = stdoutWrite.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(output).not.toContain("must-not-be-emitted");
    expect(output).not.toContain("x".repeat(100));
    expect(events.logLine).toHaveBeenCalledWith(
      "Hugging Face output suppressed after exceeding the redaction buffer limit",
    );
  });

  it("returns validation failures without spawning Docker (#8279)", async () => {
    await expect(
      acquireHuggingFaceModel(request({ hostCacheDir: "/cache/../foreign" }), observer()),
    ).resolves.toEqual({
      ok: false,
      reason: "Hugging Face cache must be a normalized absolute path without ':'",
    });
    expect(dockerSpawn).not.toHaveBeenCalled();
  });

  it("returns one spawn error and clears the download heartbeat (#8279)", async () => {
    vi.useFakeTimers();
    const proc = mockProcess();
    dockerSpawn.mockReturnValue(proc);
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
    expect(events.onRateLimit).not.toHaveBeenCalled();
    expect(stderrWrite.mock.calls.flat().join("\n")).not.toContain("hf output lines");
  });

  it("aborts a stalled download instead of waiting forever (#10346)", async () => {
    vi.useFakeTimers();
    const proc = mockProcess();
    const cleanupProc = mockProcess();
    dockerSpawn.mockReturnValueOnce(proc).mockReturnValueOnce(cleanupProc);
    const events = observer();
    const resultPromise = acquireHuggingFaceModel(request(), events);

    // Heartbeats keep their fixed cadence while real progress resets only the stall deadline.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(events.logLine).not.toHaveBeenCalledWith(expect.stringContaining("still running"));
    await vi.advanceTimersByTimeAsync(1);
    expect(events.logLine).toHaveBeenCalledWith(expect.stringContaining("still running"));
    proc.stdout.emit("data", Buffer.from("Downloading (incomplete total...): 10%\n"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.logLine).toHaveBeenCalledWith(expect.stringContaining("still running"));
    expect(proc.kill).not.toHaveBeenCalled();

    // Then output stops entirely for the full stall window.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    cleanupProc.emit("exit", 0);
    proc.emit("exit", 137);

    expect(dockerSpawn).toHaveBeenCalledTimes(2);
    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("hf download stalled"),
    });
    expect(events.logLine).toHaveBeenCalledWith(expect.stringContaining("stalled"));

    // A late exit event after the stall already resolved must not resolve again.
    proc.emit("exit", 0);
    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("hf download stalled"),
    });
  });

  it("honors NEMOCLAW_HF_DOWNLOAD_STALL_TIMEOUT below the heartbeat interval (#10346)", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NEMOCLAW_HF_DOWNLOAD_STALL_TIMEOUT", "1");
    const proc = mockProcess();
    const cleanupProc = mockProcess();
    dockerSpawn.mockReturnValueOnce(proc).mockReturnValueOnce(cleanupProc);
    const events = observer();
    const resultPromise = acquireHuggingFaceModel(request(), events);

    await vi.advanceTimersByTimeAsync(999);
    proc.stdout.emit("data", Buffer.from("Downloading: 1%\n"));
    await vi.advanceTimersByTimeAsync(999);
    expect(dockerSpawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const downloadCall = dockerSpawn.mock.calls.find(([args]) => Array.isArray(args) && args[0] === "run");
    const downloadArgv = downloadCall?.[0] as string[];
    const containerName = downloadArgv[downloadArgv.indexOf("--name") + 1];
    expect(forcedRemoveCall()).toEqual([
      ["rm", "--force", containerName],
      { env: { DOCKER_HOST: "ssh://spark.example.test" }, stdio: "ignore" },
    ]);
    cleanupProc.emit("exit", 0);
    proc.emit("exit", 137);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: "hf download stalled: no output for 1s",
    });
    expect(events.logLine).not.toHaveBeenCalledWith(expect.stringContaining("still running"));
    expect(events.logLine).not.toHaveBeenCalledWith("Model download complete");
    expect(cleanupProc.unref).toHaveBeenCalledOnce();
    expect(proc.stdout.destroy).toHaveBeenCalledOnce();
    expect(proc.stderr.destroy).toHaveBeenCalledOnce();
    expect(proc.unref).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });

  it("reports the named container and recovery command when removal is unconfirmed (#10346)", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NEMOCLAW_HF_DOWNLOAD_STALL_TIMEOUT", "1");
    const proc = mockProcess();
    const cleanupProc = mockProcess();
    dockerSpawn.mockReturnValueOnce(proc).mockReturnValueOnce(cleanupProc);
    const resultPromise = acquireHuggingFaceModel(
      request({ dockerEnv: { DOCKER_HOST: "ssh://operator:secret@spark.example.test" } }),
      observer(),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const downloadCall = dockerSpawn.mock.calls.find(([args]) => Array.isArray(args) && args[0] === "run");
    const downloadArgv = downloadCall?.[0] as string[];
    const containerName = downloadArgv[downloadArgv.indexOf("--name") + 1];
    expect(forcedRemoveCall()).toEqual([
      ["rm", "--force", containerName],
      { env: { DOCKER_HOST: "ssh://operator:secret@spark.example.test" }, stdio: "ignore" },
    ]);
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cleanupProc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(cleanupProc.unref).toHaveBeenCalledOnce();
    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: `hf download stalled: no output for 1s; cleanup unconfirmed for container ${containerName} on Docker endpoint Docker host ssh://spark.example.test; select that endpoint, run docker rm --force ${containerName}, and resume onboarding only after removal is confirmed`,
    });
    vi.unstubAllEnvs();
  });

  it("reports Docker context precedence for manual cleanup without exposing the host (#10346)", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NEMOCLAW_HF_DOWNLOAD_STALL_TIMEOUT", "1");
    const proc = mockProcess();
    const cleanupProc = mockProcess();
    dockerSpawn.mockReturnValueOnce(proc).mockReturnValueOnce(cleanupProc);
    const resultPromise = acquireHuggingFaceModel(
      request({
        dockerEnv: {
          DOCKER_CONTEXT: "remote-builder",
          DOCKER_HOST: "ssh://operator:secret@ignored.example.test",
        },
      }),
      observer(),
    );

    await vi.advanceTimersByTimeAsync(11_000);
    proc.emit("exit", 137);
    const result = await resultPromise;
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("Docker context remote-builder"),
    });
    expect(result).toEqual({ ok: false, reason: expect.any(String) });
    const reason = "reason" in result ? result.reason : "";
    expect(reason).not.toContain("ignored.example.test");
    expect(reason).not.toContain("secret");
    expect(forcedRemoveCall()[1]).toEqual({
      env: {
        DOCKER_CONTEXT: "remote-builder",
        DOCKER_HOST: "ssh://operator:secret@ignored.example.test",
      },
      stdio: "ignore",
    });
    vi.unstubAllEnvs();
  });

  it.each([
    ["exceeds the Node.js timer limit", "2147483.648"],
    ["scales past the representable range", "1e308"],
    ["floors to a zero-millisecond window", "0.0001"],
  ])(
    "keeps the default stall window when the configured timeout %s (#10346)",
    async (_reason, configured) => {
      vi.useFakeTimers();
      vi.stubEnv("NEMOCLAW_HF_DOWNLOAD_STALL_TIMEOUT", configured);
      const proc = mockProcess();
      const cleanupProc = mockProcess();
      dockerSpawn.mockReturnValueOnce(proc).mockReturnValueOnce(cleanupProc);
      const events = observer();
      const resultPromise = acquireHuggingFaceModel(request(), events);

      // A zero-millisecond window would abort at the first heartbeat, and an
      // out-of-range one would never abort at all. Pin both ends.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(proc.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(570_000);
      cleanupProc.emit("exit", 0);
      proc.emit("exit", 137);

      expect(dockerSpawn).toHaveBeenCalledTimes(2);
      await expect(resultPromise).resolves.toEqual({
        ok: false,
        reason: expect.stringContaining("hf download stalled"),
      });
      vi.unstubAllEnvs();
    },
  );

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
