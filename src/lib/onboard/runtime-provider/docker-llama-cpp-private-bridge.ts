// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/u;
const PROCESS_EXIT_WAIT_MS = 5_000;
const PROCESS_EXIT_POLL_MS = 50;
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

export interface DockerLlamaCppPrivateBridgeAuthority {
  readonly transactionId: string;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly listenPort: number;
  readonly bindAddresses: readonly ["127.0.0.1", string];
}

export interface DockerLlamaCppPrivateBridgeController {
  start(authority: DockerLlamaCppPrivateBridgeAuthority): void;
  assertRunning(authority: DockerLlamaCppPrivateBridgeAuthority): void;
  assertStopped(transactionId: string): void;
  stopTransaction(transactionId: string): void;
}

export interface DockerLlamaCppPrivateBridgeDependencies {
  readonly spawnProcess?: typeof spawn;
  readonly processIsAlive?: (pid: number) => boolean;
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly listProcessIds?: () => readonly number[];
  readonly readProcessArgv?: (pid: number) => readonly string[] | null;
  readonly sleep?: (milliseconds: number) => void;
}

function exactPort(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Docker llama.cpp private bridge ${label} is invalid.`);
  }
  return value;
}

function isPrivateIpv4(value: string): boolean {
  if (!net.isIPv4(value)) return false;
  const [first, second] = value.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168)
  );
}

function normalizeAuthority(
  value: DockerLlamaCppPrivateBridgeAuthority,
): DockerLlamaCppPrivateBridgeAuthority {
  if (
    !SHA256.test(value.transactionId) ||
    !isPrivateIpv4(value.targetHost) ||
    value.bindAddresses.length !== 2 ||
    value.bindAddresses[0] !== "127.0.0.1" ||
    !isPrivateIpv4(value.bindAddresses[1]) ||
    value.bindAddresses[1] === value.targetHost
  ) {
    throw new Error("Docker llama.cpp private bridge authority is invalid.");
  }
  return Object.freeze({
    transactionId: value.transactionId,
    targetHost: value.targetHost,
    targetPort: exactPort(value.targetPort, "target port"),
    listenPort: exactPort(value.listenPort, "listen port"),
    bindAddresses: Object.freeze([...value.bindAddresses]) as readonly ["127.0.0.1", string],
  });
}

function bridgeArguments(authorityValue: DockerLlamaCppPrivateBridgeAuthority): readonly string[] {
  const authority = normalizeAuthority(authorityValue);
  return Object.freeze([
    "--transaction",
    authority.transactionId,
    "--target-host",
    authority.targetHost,
    "--target-port",
    String(authority.targetPort),
    "--listen-port",
    String(authority.listenPort),
    "--bind-address",
    authority.bindAddresses[0],
    "--bind-address",
    authority.bindAddresses[1],
  ]);
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSignalProcess(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function defaultListProcessIds(): readonly number[] {
  if (process.platform !== "linux") {
    throw new Error("Docker llama.cpp private bridge requires a native Linux host.");
  }
  return fs
    .readdirSync("/proc", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9]+$/u.test(entry.name))
    .map((entry) => Number(entry.name));
}

function defaultReadProcessArgv(pid: number): readonly string[] | null {
  try {
    const value = fs.readFileSync(`/proc/${String(pid)}/cmdline`);
    const argv = value.toString("utf8").split("\0");
    if (argv.at(-1) === "") argv.pop();
    return argv.length > 0 ? Object.freeze(argv) : null;
  } catch {
    return null;
  }
}

function exactArgv(left: readonly string[] | null, right: readonly string[]): boolean {
  return (
    left !== null && left.length === right.length && left.every((value, i) => value === right[i])
  );
}

function defaultSleep(milliseconds: number): void {
  Atomics.wait(SLEEP_ARRAY, 0, 0, milliseconds);
}

export function createDockerLlamaCppPrivateBridgeController(
  dependencies: DockerLlamaCppPrivateBridgeDependencies = {},
): DockerLlamaCppPrivateBridgeController {
  const scriptPath = path.join(__dirname, "docker-llama-cpp-private-bridge-process.js");
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const processIsAlive = dependencies.processIsAlive ?? defaultProcessIsAlive;
  const signalProcess = dependencies.signalProcess ?? defaultSignalProcess;
  const listProcessIds = dependencies.listProcessIds ?? defaultListProcessIds;
  const readProcessArgv = dependencies.readProcessArgv ?? defaultReadProcessArgv;
  const sleep = dependencies.sleep ?? defaultSleep;

  const expectedArgv = (authority: DockerLlamaCppPrivateBridgeAuthority) =>
    Object.freeze([process.execPath, scriptPath, ...bridgeArguments(authority)]);

  const matchingProcessIds = (
    authority: DockerLlamaCppPrivateBridgeAuthority,
  ): readonly number[] => {
    const expected = expectedArgv(authority);
    return Object.freeze(
      listProcessIds()
        .filter((pid) => processIsAlive(pid) && exactArgv(readProcessArgv(pid), expected))
        .sort((left, right) => left - right),
    );
  };

  const transactionProcessIds = (transactionId: string): readonly number[] => {
    if (!SHA256.test(transactionId)) {
      throw new Error("Docker llama.cpp private bridge transaction is invalid.");
    }
    return Object.freeze(
      listProcessIds()
        .filter((pid) => {
          if (!processIsAlive(pid)) return false;
          const argv = readProcessArgv(pid);
          return (
            argv !== null &&
            argv[0] === process.execPath &&
            argv[1] === scriptPath &&
            argv[2] === "--transaction" &&
            argv[3] === transactionId
          );
        })
        .sort((left, right) => left - right),
    );
  };

  const requireOne = (authority: DockerLlamaCppPrivateBridgeAuthority): number => {
    const matches = matchingProcessIds(authority);
    if (matches.length !== 1) {
      throw new Error(
        `Docker llama.cpp private bridge has ${String(matches.length)} matching processes; expected one.`,
      );
    }
    return matches[0]!;
  };

  const stopProcessIds = (matches: readonly number[]): void => {
    for (const pid of matches) {
      try {
        signalProcess(pid, "SIGTERM");
      } catch {
        // A concurrently exited exact process is already stopped.
      }
    }
    const deadline = Date.now() + PROCESS_EXIT_WAIT_MS;
    for (const pid of matches) {
      while (processIsAlive(pid) && Date.now() < deadline) sleep(PROCESS_EXIT_POLL_MS);
      if (processIsAlive(pid)) {
        try {
          signalProcess(pid, "SIGKILL");
        } catch {
          // A concurrently exited exact process is already stopped.
        }
      }
    }
  };

  return Object.freeze({
    start(authorityValue: DockerLlamaCppPrivateBridgeAuthority) {
      const authority = normalizeAuthority(authorityValue);
      const existing = matchingProcessIds(authority);
      if (existing.length > 1) {
        throw new Error("Docker llama.cpp private bridge ownership is ambiguous.");
      }
      if (existing.length === 1) {
        return;
      }
      const stale = transactionProcessIds(authority.transactionId);
      if (stale.length > 0) stopProcessIds(stale);
      const child: ChildProcess = spawnProcess(
        process.execPath,
        [scriptPath, ...bridgeArguments(authority)],
        {
          detached: true,
          stdio: "ignore",
          shell: false,
          env: {},
        },
      );
      if (!Number.isInteger(child.pid) || !child.pid || child.pid < 1) {
        throw new Error("Docker llama.cpp private bridge did not return a process identity.");
      }
      child.unref();
    },
    assertRunning(authorityValue: DockerLlamaCppPrivateBridgeAuthority) {
      requireOne(normalizeAuthority(authorityValue));
    },
    assertStopped(transactionId: string) {
      if (transactionProcessIds(transactionId).length !== 0) {
        throw new Error("Docker llama.cpp private bridge remained active while stopped.");
      }
    },
    stopTransaction(transactionId: string) {
      stopProcessIds(transactionProcessIds(transactionId));
    },
  });
}
