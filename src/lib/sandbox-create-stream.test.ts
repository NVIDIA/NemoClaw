// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { streamSandboxCreate } from "./sandbox-create-stream";

class FakeReadable extends EventEmitter {
  destroy() {}
}

class FakeChild extends EventEmitter {
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
      spawnImpl: () => child as never,
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
      spawnImpl: () => child as never,
      heartbeatIntervalMs: 1_000,
      silentPhaseMs: 10_000,
    });

    child.stdout.emit(
      "data",
      Buffer.from("  Building image sandbox\n  Pushing image layers\nCreated sandbox: demo\n✓ Ready\n"),
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

  it("forces success when the sandbox becomes ready before the stream exits", async () => {
    vi.useFakeTimers();

    const child = new FakeChild();
    let checks = 0;
    const promise = streamSandboxCreate("echo create", process.env, {
      spawnImpl: () => child as never,
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
      spawnImpl: () => child as never,
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
      spawnImpl: () => child as never,
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
      spawnImpl: () => child as never,
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

  it("reports spawn errors cleanly", async () => {
    const child = new FakeChild();
    const promise = streamSandboxCreate("echo create", process.env, {
      spawnImpl: () => child as never,
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
