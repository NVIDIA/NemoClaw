// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared setup for the source tests that exercise installVllm:
// vllm.test.ts, vllm-install-storage.test.ts, and
// vllm-compute-capability.test.ts (#8351). vi.hoisted and
// vi.mock are hoisted per file, so each suite still declares and owns its own
// mocks. Exports that configure suite mocks take that suite's `mocks` object
// as a parameter. The setup helpers replace probe results and Docker ownership
// responses for each setup. This is not a *.test.ts file, so Vitest does not
// collect it as a suite.

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

/**
 * Replace probe results with an uncached image, writable model cache, zero
 * cached model bytes, and 1 TB storage responses.
 */
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
 * Prepare a successful vLLM setup response with prerequisite and readiness
 * probe responses plus Docker ownership responses. Each
 * `dockerCapture(["container", ...])` call alternates between two outcomes:
 * the first call and every other call after it (0, 2, 4, ...) unconditionally
 * return an empty row; the second call and every other call after that
 * (1, 3, 5, ...) consume the next entry from `ownershipResponses`. Only every
 * other container inspection reads the queue. Exhausting the queue throws so
 * an install that inspects ambient ownership more often than the test
 * intends fails loudly instead of reading an empty row.
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
  mocks.dockerSpawn.mockImplementation(() => mockDockerSpawnSuccess());
  mocks.dockerRunDetached.mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
  const ownershipQueue = [...ownershipResponses];
  let ownershipCallIndex = 0;
  const ownershipHandlers = [
    (): string => "",
    (): string =>
      (
        ownershipQueue.shift() ??
        (() => {
          throw new Error("No ambient Docker ownership response remains");
        })
      )(),
  ];
  const dockerCaptureByCommand = new Map<string, () => string>([
    ["container", () => ownershipHandlers[ownershipCallIndex++ % ownershipHandlers.length]()],
    ["ps", () => `${containerName}\n`],
  ]);
  mocks.dockerCapture.mockImplementation((args: readonly string[]) =>
    args[0] === "container" && mocks.dockerRunDetached.mock.calls.length > 0
      ? vllmContainerRow(containerName, { state: "running" })
      : (dockerCaptureByCommand.get(args[0] ?? "") ?? (() => ""))(),
  );
}

/** Prepare spies for vLLM setup output and filesystem calls. */
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

/** Clear the environment inputs read by the vLLM install suites. */
export function resetVllmInstallEnv(): void {
  delete process.env.NEMOCLAW_VLLM_MODEL;
  delete process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON;
  delete process.env.HF_TOKEN;
  delete process.env.HUGGING_FACE_HUB_TOKEN;
}
