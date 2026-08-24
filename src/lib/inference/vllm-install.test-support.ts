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
import type {
  QualificationStatus,
  ReadinessState,
  SystemReadinessReport,
} from "../readiness/types.js";
import { isHostLocalInferenceServingRecipe } from "./serving/adapter-registry.js";
import { loadManagedInferenceCatalog } from "./serving/catalog-loader.js";
import type { ManagedInferenceReadinessSource } from "./serving/types.js";
import type { InstallVllmOptions, VllmProfile } from "./vllm.js";

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

export function vllmHostCommandCapture(options: {
  computeCap: string;
  curl?: string;
  gpuMemory?: string | readonly string[];
}): (cmd: readonly string[]) => string {
  let gpuMemorySample = 0;
  return (cmd) => {
    switch (cmd[0]) {
      case "sh":
        return "/usr/bin/tool\n";
      case "nvidia-smi":
        if (!cmd.includes("--query-gpu=index,uuid,memory.total,memory.free")) {
          return options.computeCap;
        }
        if (!Array.isArray(options.gpuMemory)) {
          return options.gpuMemory ?? "0, GPU-1234, 1000000, 1000000\n";
        }
        return (
          options.gpuMemory[Math.min(gpuMemorySample++, options.gpuMemory.length - 1)] ?? ""
        );
      case "curl":
        return options.curl ?? '{"data":[]}';
      default:
        return "";
    }
  };
}

/** Build fresh, catalog-shaped readiness evidence for downstream install unit tests. */
export function vllmInstallTestReadiness(
  profile: VllmProfile,
  modelIntent = String(process.env.NEMOCLAW_VLLM_MODEL ?? "").trim(),
): readonly ManagedInferenceReadinessSource[] {
  const profileArchitecture = profile.architecture ?? process.arch;
  const expectedArchitecture = profileArchitecture === "x64" ? "amd64" : profileArchitecture;
  const catalog = loadManagedInferenceCatalog();
  const candidates = catalog.presets.flatMap((preset) => {
    if (preset.spec.plan.backend !== "vllm" || preset.spec.plan.platform !== profile.platform) {
      return [];
    }
    const recipe = catalog.recipes.find(
      ({ metadata }) => metadata.id === preset.spec.plan.recipeRef,
    );
    if (
      !recipe ||
      !isHostLocalInferenceServingRecipe(recipe) ||
      recipe.spec.runtime.architecture !== expectedArchitecture
    ) {
      return [];
    }
    const requestedModel = modelIntent || profile.defaultModel.envValue;
    const aliases = [
      recipe.spec.model.id,
      recipe.spec.model.environmentValue,
      recipe.spec.model.servedName,
    ];
    return aliases.some((value) => value.toLowerCase() === requestedModel.toLowerCase())
      ? [{ preset, recipe }]
      : [];
  });
  if (candidates.length === 0) {
    throw new Error(
      `No host-local catalog fixture matches ${modelIntent || profile.defaultModel.envValue} on ${profile.platform}/${String(expectedArchitecture)}`,
    );
  }
  const { preset } = candidates.sort(
    (left, right) => right.preset.spec.priority - left.preset.spec.priority,
  )[0]!;
  const observations = new Map<string, SystemReadinessReport["observations"][number]>();
  const capabilities = new Map<string, SystemReadinessReport["capabilities"][number]>();
  const qualifications = new Map<string, SystemReadinessReport["qualifications"][number]>();
  for (const requirement of preset.spec.requirements.all) {
    if (!("readiness" in requirement)) continue;
    const readiness = requirement.readiness;
    if (readiness.kind === "observation") {
      observations.set(
        readiness.id,
        "state" in readiness
          ? { id: readiness.id, state: readiness.state as ReadinessState }
          : {
              id: readiness.id,
              state: "present",
              value:
                readiness.comparison.operator === "one-of"
                  ? readiness.comparison.values[0]
                  : readiness.comparison.value,
            },
      );
    } else if (readiness.kind === "capability") {
      capabilities.set(readiness.id, {
        id: readiness.id,
        state: readiness.state as ReadinessState,
      });
    } else if ("status" in readiness) {
      qualifications.set(readiness.id, {
        id: readiness.id,
        status: readiness.status as QualificationStatus,
      });
    }
  }
  const unifiedMemory = profile.platform !== "linux";
  observations.set("host.gpu.unified_memory", {
    id: "host.gpu.unified_memory",
    state: "present",
    value: unifiedMemory,
  });
  observations.set("host.gpu.memory_total_bytes", {
    id: "host.gpu.memory_total_bytes",
    state: "present",
    value: 1_000_000_000_000,
  });
  observations.set("host.gpu.memory_per_device_bytes", {
    id: "host.gpu.memory_per_device_bytes",
    state: "present",
    value: 1_000_000_000_000,
  });
  const report = {
    schemaVersion: "1.1.0",
    status: "supported",
    exitCode: 0,
    mutated: false,
    provenance: {
      nemoclawVersion: "0.1.0",
      sourceRevision: "0".repeat(40),
      observedAt: new Date().toISOString(),
    },
    observations: [...observations.values()],
    capabilities: [...capabilities.values()],
    qualifications: [...qualifications.values()],
    findings: [],
    evidence: [],
  } satisfies SystemReadinessReport;
  return [{ nodeId: "vllm-install-test-host", report }];
}

export function withVllmInstallTestReadiness(
  profile: VllmProfile,
  options: InstallVllmOptions,
): InstallVllmOptions {
  return {
    resolveManagedBridgeHost: () => "172.18.0.1",
    ...options,
    readinessReports: vllmInstallTestReadiness(profile),
  };
}

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
  mocks.runCapture.mockImplementation((cmd: readonly string[]) => {
    if (cmd[0] === "nvidia-smi") {
      return cmd.includes("--query-gpu=index,uuid,memory.total,memory.free")
        ? "0, GPU-00000000-0000-0000-0000-000000000000, 1000000, 1000000\n"
        : "12.1\n";
    }
    return runCaptureByCommand[cmd[0] ?? ""] ?? "";
  });
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
  delete process.env.NEMOCLAW_SERVING_PRESET;
  delete process.env.HF_TOKEN;
  delete process.env.HUGGING_FACE_HUB_TOKEN;
}
