// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type StreamableChildProcess,
  type StreamableReadable,
  streamSandboxCreate,
} from "./sandbox-create-stream";

class FakeReadable extends EventEmitter implements StreamableReadable {
  destroy(): void {}
}

class FakeChild extends EventEmitter implements StreamableChildProcess {
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  kill = vi.fn();
  unref = vi.fn();
}

describe("sandbox-create-stream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prints the initial build banner immediately", async () => {
    const child = new FakeChild();
    const logLine = vi.fn();
    const promise = streamSandboxCreate("echo create", process.env, {
      logLine,
      spawnImpl: () => child,
    });

    expect(logLine).toHaveBeenCalledWith("  Building sandbox image...");
    child.emit("close", 0);
    await promise;
  });

  it("streams visible progress lines and returns the collected output", async () => {
    const child = new FakeChild();
    const logLine = vi.fn();
    const promise = streamSandboxCreate("echo create", process.env, {
      logLine,
      spawnImpl: () => child,
      heartbeatIntervalMs: 1_000,
      silentPhaseMs: 10_000,
    });

    child.stdout.emit(
      "data",
      Buffer.from(
        "  Building image sandbox\n  Pushing image layers\nCreated sandbox: demo\n✓ Ready\n",
      ),
    );
    child.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      status: 0,
      sawProgress: true,
      output: expect.stringContaining("Created sandbox: demo"),
    });
    expect(logLine).toHaveBeenCalledWith("  Building image sandbox");
    expect(logLine).toHaveBeenCalledWith("  Pushing image layers");
    expect(logLine).toHaveBeenCalledWith("Created sandbox: demo");
  });

  it("streams BuildKit progress lines as build output", async () => {
    const child = new FakeChild();
    const logLine = vi.fn();
    const promise = streamSandboxCreate("echo create", process.env, {
      logLine,
      spawnImpl: () => child as never,
      heartbeatIntervalMs: 1_000,
      silentPhaseMs: 10_000,
    });

    child.stdout.emit(
      "data",
      Buffer.from("#1 [internal] load build definition from Dockerfile\n#2 CACHED\n#3 DONE 0.1s\n"),
    );
    child.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      status: 0,
      sawProgress: true,
      output: expect.stringContaining("#1 [internal] load build definition from Dockerfile"),
    });
    expect(logLine).toHaveBeenCalledWith("#1 [internal] load build definition from Dockerfile");
    expect(logLine).toHaveBeenCalledWith("#2 CACHED");
    expect(logLine).toHaveBeenCalledWith("#3 DONE 0.1s");
  });

  it("forces success when the sandbox becomes ready before the stream exits", async () => {
    vi.useFakeTimers();

    const child = new FakeChild();
    let checks = 0;
    const promise = streamSandboxCreate("echo create", process.env, {
      spawnImpl: () => child,
      readyCheck: () => {
        checks += 1;
        return checks >= 2;
      },
      pollIntervalMs: 5,
      heartbeatIntervalMs: 1_000,
      silentPhaseMs: 10_000,
      logLine: vi.fn(),
    });

    child.stdout.emit("data", Buffer.from("  Building image sandbox\n"));
    await vi.advanceTimersByTimeAsync(12);

    await expect(promise).resolves.toMatchObject({
      status: 0,
      sawProgress: true,
      forcedReady: true,
      output: expect.stringContaining("Sandbox reported Ready before create stream exited"),
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.unref).toHaveBeenCalled();
  });

  it("flushes the final partial line before resolving", async () => {
    const child = new FakeChild();
    const promise = streamSandboxCreate("echo create", process.env, {
      spawnImpl: () => child,
      logLine: vi.fn(),
    });

    child.stdout.emit("data", Buffer.from("Created sandbox: demo"));
    child.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      status: 0,
      output: "Created sandbox: demo",
      sawProgress: true,
    });
  });

  it("recovers when sandbox is ready at the moment the stream exits non-zero", async () => {
    const child = new FakeChild();
    const logLine = vi.fn();
    const promise = streamSandboxCreate("echo create", process.env, {
      spawnImpl: () => child,
      readyCheck: () => true, // sandbox is already Ready
      pollIntervalMs: 60_000, // large interval so the poll doesn't fire first
      heartbeatIntervalMs: 1_000,
      silentPhaseMs: 10_000,
      logLine,
    });

    child.stdout.emit("data", Buffer.from("Created sandbox: demo\n"));
    // SSH 255 — stream exits non-zero after sandbox was created
    child.emit("close", 255);

    await expect(promise).resolves.toMatchObject({
      status: 0,
      forcedReady: true,
      sawProgress: true,
    });
  });

  it("returns non-zero when readyCheck is false at close time", async () => {
    const child = new FakeChild();
    const promise = streamSandboxCreate("echo create", process.env, {
      spawnImpl: () => child,
      readyCheck: () => false, // sandbox is NOT ready
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 1_000,
      silentPhaseMs: 10_000,
      logLine: vi.fn(),
    });

    child.stdout.emit("data", Buffer.from("Created sandbox: demo\n"));
    child.emit("close", 255);

    await expect(promise).resolves.toMatchObject({
      status: 255,
      sawProgress: true,
    });
    expect((await promise).forcedReady).toBeUndefined();
  });

  it("announces the pull phase when base image download progress appears (classic docker)", async () => {
    const child = new FakeChild();
    const logLine = vi.fn();
    const promise = streamSandboxCreate("echo create", process.env, {
      logLine,
      spawnImpl: () => child as never,
      heartbeatIntervalMs: 1_000,
      silentPhaseMs: 10_000,
    });

    child.stdout.emit(
      "data",
      Buffer.from(
        "latest: Pulling from nvidia/nemoclaw/sandbox-base\n" +
          "abc123def: Pulling fs layer\n" +
          "abc123def: Downloading  12MB/50MB\n" +
          "abc123def: Pull complete\n" +
          "Digest: sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" +
          "Status: Downloaded newer image for ghcr.io/nvidia/nemoclaw/sandbox-base:latest\n" +
          "  Step 1/45 : FROM ghcr.io/nvidia/nemoclaw/sandbox-base:latest\n",
      ),
    );
    child.emit("close", 0);

    await expect(promise).resolves.toMatchObject({ status: 0, sawProgress: true });
    expect(logLine).toHaveBeenCalledWith("  Pulling base image from registry...");
    expect(logLine).toHaveBeenCalledWith("latest: Pulling from nvidia/nemoclaw/sandbox-base");
    expect(logLine).toHaveBeenCalledWith(
      "Status: Downloaded newer image for ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
    );
  });

  it("announces the pull phase for BuildKit pull progress", async () => {
    const child = new FakeChild();
    const logLine = vi.fn();
    const promise = streamSandboxCreate("echo create", process.env, {
      logLine,
      spawnImpl: () => child as never,
      heartbeatIntervalMs: 1_000,
      silentPhaseMs: 10_000,
    });

    child.stdout.emit(
      "data",
      Buffer.from(
        "#3 resolve ghcr.io/nvidia/nemoclaw/sandbox-base:latest\n" +
          "#3 sha256:aa11bb22 12.34MB / 45.67MB 3.2s\n",
      ),
    );
    child.emit("close", 0);

    await expect(promise).resolves.toMatchObject({ status: 0, sawProgress: true });
    expect(logLine).toHaveBeenCalledWith("  Pulling base image from registry...");
    // Lock in that BuildKit progress lines actually reach the user — guards against
    // silent regressions where shouldShowLine drops the BuildKit pull patterns.
    expect(logLine).toHaveBeenCalledWith(
      expect.stringContaining("#3 resolve ghcr.io/nvidia/nemoclaw/sandbox-base:latest"),
    );
    expect(logLine).toHaveBeenCalledWith(
      expect.stringContaining("#3 sha256:aa11bb22 12.34MB / 45.67MB 3.2s"),
    );
  });

  it("recognizes non-lowercase image tag prefixes in 'Pulling from' lines", async () => {
    const child = new FakeChild();
    const logLine = vi.fn();
    const promise = streamSandboxCreate("echo create", process.env, {
      logLine,
      spawnImpl: () => child as never,
      heartbeatIntervalMs: 1_000,
      silentPhaseMs: 10_000,
    });

    child.stdout.emit(
      "data",
      Buffer.from(
        "v1.2.3: Pulling from nvidia/nemoclaw/sandbox-base\n" +
          "cuda-12.5: Pulling from nvidia/cuda\n" +
          "12.4: Pulling from library/python\n",
      ),
    );
    child.emit("close", 0);

    await expect(promise).resolves.toMatchObject({ status: 0 });
    expect(logLine).toHaveBeenCalledWith("  Pulling base image from registry...");
    expect(logLine).toHaveBeenCalledWith("v1.2.3: Pulling from nvidia/nemoclaw/sandbox-base");
    expect(logLine).toHaveBeenCalledWith("cuda-12.5: Pulling from nvidia/cuda");
    expect(logLine).toHaveBeenCalledWith("12.4: Pulling from library/python");
  });

  it("emits a pull-phase heartbeat instead of a build-phase one during base image download", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const logLine = vi.fn();
    const promise = streamSandboxCreate("echo create", process.env, {
      logLine,
      spawnImpl: () => child as never,
      heartbeatIntervalMs: 100,
      silentPhaseMs: 50,
    });

    child.stdout.emit("data", Buffer.from("abc123def: Pulling fs layer\n"));
    await vi.advanceTimersByTimeAsync(200);
    child.emit("close", 0);
    await promise;

    const calls = logLine.mock.calls.map((c) => c[0] as string);
    expect(calls.some((l) => /Still pulling base image from registry\.\.\./.test(l))).toBe(true);
    expect(calls.some((l) => /Still building sandbox image\.\.\./.test(l))).toBe(false);
  });

  it("reports spawn errors cleanly", async () => {
    const child = new FakeChild();
    const promise = streamSandboxCreate("echo create", process.env, {
      spawnImpl: () => child,
      logLine: vi.fn(),
    });

    child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    await expect(promise).resolves.toEqual({
      status: 1,
      output: "spawn failed: ENOENT (ENOENT)",
      sawProgress: false,
    });
  });
});
