// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess, spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";
import {
  createDockerLlamaCppPrivateBridgeController,
  type DockerLlamaCppPrivateBridgeAuthority,
} from "./docker-llama-cpp-private-bridge";
import { parseLlamaCppPrivateBridgeArguments } from "./docker-llama-cpp-private-bridge-process";

const TRANSACTION = "9".repeat(64);
const authority: DockerLlamaCppPrivateBridgeAuthority = {
  transactionId: TRANSACTION,
  targetHost: "172.30.0.2",
  targetPort: 8081,
  listenPort: 8081,
  bindAddresses: ["127.0.0.1", "172.29.0.1"],
};

function fixture() {
  let nextPid = 40_001;
  const processes = new Map<number, readonly string[]>();
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const spawnProcess = vi.fn((file: string, args: readonly string[]) => {
    const pid = nextPid++;
    processes.set(pid, [file, ...args]);
    return { pid, unref: vi.fn() } as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  const controller = createDockerLlamaCppPrivateBridgeController({
    spawnProcess,
    processIsAlive: (pid) => processes.has(pid),
    signalProcess: (pid, signal) => {
      signals.push({ pid, signal });
      processes.delete(pid);
    },
    listProcessIds: () => [...processes.keys()],
    readProcessArgv: (pid) => processes.get(pid) ?? null,
    sleep: vi.fn(),
  });
  return { controller, processes, signals, spawnProcess };
}

describe("Docker llama.cpp private bridge controller", () => {
  it("owns one exact transaction-scoped bridge and stops only that process", () => {
    const { controller, processes, signals, spawnProcess } = fixture();
    controller.start(authority);
    controller.assertRunning(authority);
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        expect.stringMatching(/docker-llama-cpp-private-bridge-process\.js$/u),
        "--transaction",
        TRANSACTION,
      ]),
      expect.objectContaining({ detached: true, env: {}, shell: false, stdio: "ignore" }),
    );
    expect([...processes.values()][0]).toEqual(
      expect.arrayContaining([
        "--transaction",
        TRANSACTION,
        "--target-host",
        "172.30.0.2",
        "--bind-address",
        "127.0.0.1",
        "--bind-address",
        "172.29.0.1",
      ]),
    );
    controller.stopTransaction(TRANSACTION);
    controller.assertStopped(TRANSACTION);
    expect(signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
  });

  it("replaces drifted authority for the same transaction without touching another process", () => {
    const { controller, processes, signals } = fixture();
    controller.start(authority);
    const unrelated = [...processes.values()][0]!.slice();
    unrelated[3] = "8".repeat(64);
    processes.set(50_000, unrelated);
    controller.start({ ...authority, targetHost: "172.30.0.3" });
    expect(signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    expect(processes.has(50_000)).toBe(true);
    controller.assertRunning({ ...authority, targetHost: "172.30.0.3" });
  });

  it("fails closed when exact bridge ownership is ambiguous", () => {
    const { controller, processes } = fixture();
    controller.start(authority);
    processes.set(50_000, [...processes.values()][0]!);
    expect(() => controller.assertRunning(authority)).toThrow("2 matching processes");
  });
});

describe("llama.cpp private bridge argument boundary", () => {
  const argv = [
    "--transaction",
    TRANSACTION,
    "--target-host",
    "172.30.0.2",
    "--target-port",
    "8081",
    "--listen-port",
    "8081",
    "--bind-address",
    "127.0.0.1",
    "--bind-address",
    "172.29.0.1",
  ];

  it("accepts only the exact private loopback and OpenShell bridge topology", () => {
    expect(parseLlamaCppPrivateBridgeArguments(argv)).toEqual(authority);
    const publicTarget = argv.slice();
    publicTarget[3] = "8.8.8.8";
    expect(() => parseLlamaCppPrivateBridgeArguments(publicTarget)).toThrow("authority is invalid");
    const broadListener = argv.slice();
    broadListener[11] = "0.0.0.0";
    expect(() => parseLlamaCppPrivateBridgeArguments(broadListener)).toThrow(
      "authority is invalid",
    );
  });
});
