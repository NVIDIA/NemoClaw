// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared setup mechanics for the two source suites that drive installVllm:
// vllm.test.ts and vllm-install-storage.test.ts (#8351). vi.hoisted and
// vi.mock are hoisted per file, so each suite still declares and owns its own
// mocks; every export here takes that object as a parameter. Nothing in this
// module holds mutable state, so each call returns fresh state. Not a
// *.test.ts file, so Vitest does not collect it as a suite.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type Mock, type MockInstance, vi } from "vitest";

export type VllmInstallMocks = {
  dockerCapture: Mock;
  dockerForceRm: Mock;
  dockerImageInspectFormat: Mock;
  dockerPullWithProgressWatchdog: Mock;
  dockerRunDetached: Mock;
  dockerSpawn: Mock;
  dockerStop: Mock;
  findUnwritableModelCachePath: Mock;
  getGpuIndicesByName: Mock<(_pattern: RegExp) => number[]>;
  measureDirectorySizeBytes: Mock;
  probeDockerStorage: Mock;
  probeHostStorage: Mock;
  runCapture: Mock;
};

export type SpawnedProcessStub = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
};

export type VllmInstallSpies = {
  logSpy: MockInstance;
  errSpy: MockInstance;
  mkdirSpy: MockInstance;
  stdoutWrite: MockInstance;
  stderrWrite: MockInstance;
  restore: () => void;
};

export const MANAGED_CONTAINER_ID = "a".repeat(64);

export function vllmContainerRow(
  containerName: string,
  { id = MANAGED_CONTAINER_ID, label = "true", state = "exited" } = {},
): string {
  return `${id}|${containerName}|${state}|${label}|||`;
}

/** Apply the ordinary probe results a vLLM install sees when nothing is constrained. */
export function applyVllmInstallProbeDefaults(mocks: VllmInstallMocks): void {
  mocks.dockerImageInspectFormat.mockReturnValue("");
  mocks.findUnwritableModelCachePath.mockReturnValue(null);
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
}

export function inconclusiveModelStorage(reason = "statfs unavailable") {
  return {
    ok: false as const,
    reason,
    path: path.join(os.homedir(), ".cache", "huggingface"),
    source: "Hugging Face cache",
  };
}

export function mockInconclusiveDockerStorage(mocks: VllmInstallMocks): void {
  mocks.probeDockerStorage.mockReturnValue({
    ok: false,
    reason: "Docker uses a remote endpoint (ssh://builder.example.test)",
  });
}

function spawnedProcessStub(): SpawnedProcessStub {
  const proc = new EventEmitter() as SpawnedProcessStub;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

export function mockDockerSpawnSuccess(): SpawnedProcessStub {
  const proc = spawnedProcessStub();
  process.nextTick(() => proc.emit("exit", 0));
  return proc;
}

export function mockDockerSpawnFailure(
  chunks: readonly { stream: "stdout" | "stderr"; data: string | Buffer }[],
  exitCode = 1,
): SpawnedProcessStub {
  const proc = spawnedProcessStub();
  process.nextTick(() => {
    for (const chunk of chunks) {
      const data = Buffer.isBuffer(chunk.data) ? chunk.data : Buffer.from(chunk.data);
      proc[chunk.stream].emit("data", data);
    }
    proc.emit("exit", exitCode);
  });
  return proc;
}

/**
 * Drive a managed vLLM install down its successful path. `ownershipResponses`
 * supplies the ambient ownership inspections in order; exhausting the queue
 * throws so an install that inspects more often than the test intends fails
 * loudly instead of reading an empty row.
 */
export function mockSuccessfulVllmInstall(
  mocks: VllmInstallMocks,
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
  let ownershipCallIndex = 0;
  const ownershipHandlers = [
    (): string => "",
    (): string =>
      (
        ownershipQueue.shift() ??
        (() => {
          throw new Error("Unexpected extra ambient vLLM ownership inspection");
        })
      )(),
  ];
  const dockerCaptureByCommand = new Map<string, () => string>([
    ["container", () => ownershipHandlers[ownershipCallIndex++ % ownershipHandlers.length]()],
    ["ps", () => `${containerName}\n`],
  ]);
  mocks.dockerCapture.mockImplementation((args: readonly string[]) =>
    (dockerCaptureByCommand.get(args[0] ?? "") ?? (() => ""))(),
  );
}

/** Silence and capture the console, cache-directory, and stream writes an install performs. */
export function createVllmInstallSpies(): VllmInstallSpies {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return {
    logSpy,
    errSpy,
    mkdirSpy,
    stdoutWrite,
    stderrWrite,
    restore(): void {
      logSpy.mockRestore();
      errSpy.mockRestore();
      mkdirSpy.mockRestore();
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    },
  };
}

/** Clear the env vars both install suites read, without setting one for either. */
export function resetVllmInstallEnv(): void {
  delete process.env.NEMOCLAW_VLLM_MODEL;
  delete process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON;
  delete process.env.HF_TOKEN;
  delete process.env.HUGGING_FACE_HUB_TOKEN;
}
