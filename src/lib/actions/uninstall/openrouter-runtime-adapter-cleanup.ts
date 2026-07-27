// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sleepMs } from "../../core/wait";
import type { UninstallPaths } from "../../domain/uninstall/paths";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface RuntimeAdapterCleanupRuntime {
  commandExists: (command: string) => boolean;
  env: NodeJS.ProcessEnv;
  existsSync: (target: string) => boolean;
  kill: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  log: (message: string) => void;
  run: (command: string, args: string[], options?: SpawnSyncOptions) => RunResult;
  warn: (message: string) => void;
}

const OPENROUTER_RUNTIME_ADAPTER_CMDLINE_MARK = "openrouter-runtime-adapter";
const DEFAULT_OPENROUTER_RUNTIME_ADAPTER_PORT = 11437;
const HTTPS_PIN_RUNTIME_ADAPTER_CMDLINE_MARK = "https-pin-runtime-adapter";
const DEFAULT_HTTPS_PIN_RUNTIME_ADAPTER_PORT = 11438;

type RuntimeAdapterDescriptor = {
  cmdlineMark: string;
  defaultPort: number;
  envPort: string;
  label: string;
  pidFile: string;
};

function splitNonEmptyLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveRuntimeAdapterPort(
  runtime: RuntimeAdapterCleanupRuntime,
  descriptor: RuntimeAdapterDescriptor,
): number {
  const raw = runtime.env[descriptor.envPort];
  if (raw === undefined || raw === "") return descriptor.defaultPort;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return descriptor.defaultPort;
  const parsed = Number(trimmed);
  if (parsed < 1024 || parsed > 65535) return descriptor.defaultPort;
  return parsed;
}

function isRuntimeAdapterPid(
  pid: number,
  runtime: RuntimeAdapterCleanupRuntime,
  descriptor: RuntimeAdapterDescriptor,
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const result = runtime.run("ps", ["-p", String(pid), "-o", "args="], { env: runtime.env });
  return result.status === 0 && result.stdout.includes(descriptor.cmdlineMark);
}

function pidExists(pid: number, runtime: RuntimeAdapterCleanupRuntime): boolean {
  return runtime.run("ps", ["-p", String(pid), "-o", "pid="], { env: runtime.env }).status === 0;
}

function waitForPidExit(
  pid: number,
  runtime: RuntimeAdapterCleanupRuntime,
  timeoutMs: number,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid, runtime)) return true;
    sleepMs(50);
  }
  return !pidExists(pid, runtime);
}

function pidOwnedByCurrentUser(pid: number, runtime: RuntimeAdapterCleanupRuntime): boolean {
  const expected = runtime.env.SUDO_USER || runtime.env.LOGNAME || os.userInfo().username;
  if (!expected) return true;
  const result = runtime.run("ps", ["-p", String(pid), "-o", "user="], { env: runtime.env });
  return result.status === 0 && result.stdout.trim() === expected;
}

function tryStopRuntimeAdapterPid(
  pid: number,
  runtime: RuntimeAdapterCleanupRuntime,
  descriptor: RuntimeAdapterDescriptor,
): boolean {
  runtime.kill(pid);
  if (waitForPidExit(pid, runtime, 1000)) {
    runtime.log(`Stopped ${descriptor.label} ${pid}`);
    return true;
  }
  runtime.kill(pid, "SIGKILL");
  if (waitForPidExit(pid, runtime, 1000)) {
    runtime.log(`Stopped ${descriptor.label} ${pid}`);
    return true;
  }
  runtime.warn(`Failed to stop ${descriptor.label} ${pid}`);
  return false;
}

function stopRuntimeAdapter(
  paths: Pick<UninstallPaths, "nemoclawStateDir">,
  runtime: RuntimeAdapterCleanupRuntime,
  descriptor: RuntimeAdapterDescriptor,
  options: { scanOrphans?: boolean } = {},
): void {
  const stopped = new Set<number>();

  const pidFile = path.join(paths.nemoclawStateDir, descriptor.pidFile);
  if (runtime.existsSync(pidFile)) {
    try {
      const raw = fs.readFileSync(pidFile, "utf-8").trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0 && isRuntimeAdapterPid(pid, runtime, descriptor)) {
        if (tryStopRuntimeAdapterPid(pid, runtime, descriptor)) stopped.add(pid);
      }
    } catch {
      /* ignore - the State step deletes the file shortly anyway */
    }
  }

  if (options.scanOrphans === false) {
    if (stopped.size === 0) runtime.log(`No selected-gateway ${descriptor.label} found`);
    return;
  }

  if (!runtime.commandExists("lsof")) {
    if (stopped.size === 0) {
      runtime.warn(`lsof not found; skipping orphan ${descriptor.label} scan.`);
    }
    return;
  }

  const adapterPort = resolveRuntimeAdapterPort(runtime, descriptor);
  const lsof = runtime.run("lsof", ["-ti", `:${adapterPort}`], { env: runtime.env });
  const pids = splitNonEmptyLines(lsof.stdout).map(Number).filter(Number.isFinite);
  for (const pid of pids) {
    if (stopped.has(pid)) continue;
    if (!pidOwnedByCurrentUser(pid, runtime)) continue;
    if (!isRuntimeAdapterPid(pid, runtime, descriptor)) continue;
    if (tryStopRuntimeAdapterPid(pid, runtime, descriptor)) stopped.add(pid);
  }

  if (stopped.size === 0) runtime.log(`No ${descriptor.label} processes found`);
}

export function stopOpenRouterRuntimeAdapter(
  paths: Pick<UninstallPaths, "nemoclawStateDir">,
  runtime: RuntimeAdapterCleanupRuntime,
  options: { scanOrphans?: boolean } = {},
): void {
  stopRuntimeAdapter(
    paths,
    runtime,
    {
      cmdlineMark: OPENROUTER_RUNTIME_ADAPTER_CMDLINE_MARK,
      defaultPort: DEFAULT_OPENROUTER_RUNTIME_ADAPTER_PORT,
      envPort: "NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT",
      label: "OpenRouter Runtime adapter",
      pidFile: "openrouter-runtime-adapter.pid",
    },
    options,
  );
}

export function stopHttpsPinRuntimeAdapter(
  paths: Pick<UninstallPaths, "nemoclawStateDir">,
  runtime: RuntimeAdapterCleanupRuntime,
  options: { scanOrphans?: boolean } = {},
): void {
  stopRuntimeAdapter(
    paths,
    runtime,
    {
      cmdlineMark: HTTPS_PIN_RUNTIME_ADAPTER_CMDLINE_MARK,
      defaultPort: DEFAULT_HTTPS_PIN_RUNTIME_ADAPTER_PORT,
      envPort: "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT",
      label: "HTTPS Pin Runtime adapter",
      pidFile: "https-pin-runtime-adapter.pid",
    },
    options,
  );
}
