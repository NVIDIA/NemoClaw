// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../runner", () => ({
  ROOT: "/repo/root",
  run: vi.fn(),
  runCapture: vi.fn(),
}));

import {
  type DockerPullChildProcess,
  type DockerPullReadable,
  dockerPullProgressSignature,
  dockerPullWithProgressWatchdog,
} from "./pull";

class FakeReadable extends EventEmitter implements DockerPullReadable {}

class FakeChild extends EventEmitter implements DockerPullChildProcess {
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  kill = vi.fn((signal?: NodeJS.Signals | number) => {
    queueMicrotask(() => this.emit("close", null, signal ?? "SIGTERM"));
    return true;
  });
}

describe("docker pull progress watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses Docker pull progress signatures from phase and byte-count lines", () => {
    expect(dockerPullProgressSignature("latest: Pulling from nvidia/vllm")).toBe(
      "source:latest: Pulling from nvidia/vllm",
    );
    expect(dockerPullProgressSignature("abc123def: Downloading [==> ] 12.5MB/1.2GB")).toBe(
      "layer:abc123def:Downloading:12.5MB/1.2GB",
    );
    expect(dockerPullProgressSignature("abc123def: Extracting  250 MB/1 GB")).toBe(
      "layer:abc123def:Extracting:250MB/1GB",
    );
    expect(dockerPullProgressSignature("abc123def: Pull complete")).toBe(
      "layer:abc123def:Pull complete",
    );
    expect(
      dockerPullProgressSignature(
        "e20d54a357dc: Extracting [=====>                                             ]  10.03MB/84.19MB",
      ),
    ).toBe("layer:e20d54a357dc:Extracting:10.03MB/84.19MB");
    expect(
      dockerPullProgressSignature(
        "e5eda78c7490: Downloading [============================>                      ]  17.83MB/30.76MB",
      ),
    ).toBe("layer:e5eda78c7490:Downloading:17.83MB/30.76MB");
    expect(dockerPullProgressSignature("b39b21d4717d: Download complete ")).toBe(
      "layer:b39b21d4717d:Download complete",
    );
    expect(
      dockerPullProgressSignature("#12 sha256:abc123 25.4MB/100MB 4.0s 10.1MB/s"),
    ).toBeNull();
  });

  it("spawns plain docker pull without unsupported progress flags", async () => {
    const child = new FakeChild();
    const spawnImpl = vi.fn(() => child);
    const pull = dockerPullWithProgressWatchdog("example/image:latest", {
      suppressOutput: true,
      spawnImpl,
    });

    child.emit("close", 0, null);

    await expect(pull).resolves.toMatchObject({ status: 0 });
    expect(spawnImpl).toHaveBeenCalledWith(
      ["pull", "example/image:latest"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("allows slow pulls to continue while byte progress advances", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const pull = dockerPullWithProgressWatchdog("example/image:latest", {
      suppressOutput: true,
      stallTimeoutMs: 1_000,
      maxTimeoutMs: 10_000,
      watchdogIntervalMs: 100,
      spawnImpl: () => child,
    });

    child.stderr.emit("data", Buffer.from("abc123def: Downloading 1MB/10MB\r"));
    await vi.advanceTimersByTimeAsync(900);
    expect(child.kill).not.toHaveBeenCalled();

    child.stderr.emit("data", Buffer.from("abc123def: Downloading 2MB/10MB\r"));
    await vi.advanceTimersByTimeAsync(900);
    expect(child.kill).not.toHaveBeenCalled();

    child.emit("close", 0, null);
    await expect(pull).resolves.toMatchObject({
      status: 0,
      timedOut: false,
      timeoutKind: null,
    });
  });

  it("kills a pull when output repeats without forward progress", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const pull = dockerPullWithProgressWatchdog("example/image:latest", {
      suppressOutput: true,
      stallTimeoutMs: 1_000,
      maxTimeoutMs: 10_000,
      watchdogIntervalMs: 100,
      spawnImpl: () => child,
    });

    child.stderr.emit("data", Buffer.from("abc123def: Downloading 1MB/10MB\r"));
    await vi.advanceTimersByTimeAsync(500);
    child.stderr.emit("data", Buffer.from("abc123def: Downloading 1MB/10MB\r"));
    await vi.advanceTimersByTimeAsync(600);

    await expect(pull).resolves.toMatchObject({
      status: 124,
      timedOut: true,
      timeoutKind: "stall",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("keeps returned diagnostics to a bounded output tail", async () => {
    const child = new FakeChild();
    const emitted: string[] = [];
    const pull = dockerPullWithProgressWatchdog("example/image:latest", {
      logLine: (line) => emitted.push(line),
      spawnImpl: () => child,
    });

    for (let i = 0; i < 210; i += 1) {
      child.stderr.emit("data", Buffer.from(`diagnostic line ${String(i)}\n`));
    }
    child.emit("close", 1, null);

    const result = await pull;
    expect(emitted).toHaveLength(210);
    expect(result.output.split("\n")).toHaveLength(200);
    expect(result.output).not.toContain("diagnostic line 0");
    expect(result.output).toContain("diagnostic line 209");
  });

  it("clamps positive sub-millisecond watchdog intervals to 1ms", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const pull = dockerPullWithProgressWatchdog("example/image:latest", {
      suppressOutput: true,
      stallTimeoutMs: 0.5,
      maxTimeoutMs: 10_000,
      watchdogIntervalMs: 0.5,
      spawnImpl: () => child,
    });

    await vi.advanceTimersByTimeAsync(2);

    await expect(pull).resolves.toMatchObject({
      status: 124,
      timedOut: true,
      timeoutKind: "stall",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("enforces the maximum safety budget even when progress keeps advancing", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const pull = dockerPullWithProgressWatchdog("example/image:latest", {
      suppressOutput: true,
      stallTimeoutMs: 1_000,
      maxTimeoutMs: 2_000,
      watchdogIntervalMs: 100,
      spawnImpl: () => child,
    });

    child.stderr.emit("data", Buffer.from("abc123def: Downloading 1MB/10MB\r"));
    await vi.advanceTimersByTimeAsync(900);
    child.stderr.emit("data", Buffer.from("abc123def: Downloading 2MB/10MB\r"));
    await vi.advanceTimersByTimeAsync(900);
    child.stderr.emit("data", Buffer.from("abc123def: Downloading 3MB/10MB\r"));
    await vi.advanceTimersByTimeAsync(300);

    await expect(pull).resolves.toMatchObject({
      status: 124,
      timedOut: true,
      timeoutKind: "max",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("returns a failed result when docker pull fails to spawn", async () => {
    const child = new FakeChild();
    const pull = dockerPullWithProgressWatchdog("example/image:latest", {
      suppressOutput: true,
      spawnImpl: () => child,
    });
    const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" });

    child.emit("error", error);

    await expect(pull).resolves.toMatchObject({
      status: 1,
      timedOut: false,
      timeoutKind: null,
      error,
    });
  });
});
