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

interface OpenRouterRuntimeAdapterCleanupRuntime {
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

function splitNonEmptyLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveOpenRouterRuntimeAdapterPort(
  runtime: OpenRouterRuntimeAdapterCleanupRuntime,
): number {
  const raw = runtime.env.NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT;
  if (raw === undefined || raw === "") return DEFAULT_OPENROUTER_RUNTIME_ADAPTER_PORT;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_OPENROUTER_RUNTIME_ADAPTER_PORT;
  const parsed = Number(trimmed);
  if (parsed < 1024 || parsed > 65535) return DEFAULT_OPENROUTER_RUNTIME_ADAPTER_PORT;
  return parsed;
}

function isOpenRouterRuntimeAdapterPid(
  pid: number,
  runtime: OpenRouterRuntimeAdapterCleanupRuntime,
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const result = runtime.run("ps", ["-p", String(pid), "-o", "args="], { env: runtime.env });
  return result.status === 0 && result.stdout.includes(OPENROUTER_RUNTIME_ADAPTER_CMDLINE_MARK);
}

function pidExists(pid: number, runtime: OpenRouterRuntimeAdapterCleanupRuntime): boolean {
  return runtime.run("ps", ["-p", String(pid), "-o", "pid="], { env: runtime.env }).status === 0;
}

function waitForPidExit(
  pid: number,
  runtime: OpenRouterRuntimeAdapterCleanupRuntime,
  timeoutMs: number,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid, runtime)) return true;
    sleepMs(50);
  }
  return !pidExists(pid, runtime);
}

function pidOwnedByCurrentUser(
  pid: number,
  runtime: OpenRouterRuntimeAdapterCleanupRuntime,
): boolean {
  const expected = runtime.env.SUDO_USER || runtime.env.LOGNAME || os.userInfo().username;
  if (!expected) return true;
  const result = runtime.run("ps", ["-p", String(pid), "-o", "user="], { env: runtime.env });
  return result.status === 0 && result.stdout.trim() === expected;
}

function tryStopOpenRouterRuntimeAdapterPid(
  pid: number,
  runtime: OpenRouterRuntimeAdapterCleanupRuntime,
): boolean {
  runtime.kill(pid);
  if (waitForPidExit(pid, runtime, 1000)) {
    runtime.log(`Stopped OpenRouter Runtime adapter ${pid}`);
    return true;
  }
  runtime.kill(pid, "SIGKILL");
  if (waitForPidExit(pid, runtime, 1000)) {
    runtime.log(`Stopped OpenRouter Runtime adapter ${pid}`);
    return true;
  }
  runtime.warn(`Failed to stop OpenRouter Runtime adapter ${pid}`);
  return false;
}

export function stopOpenRouterRuntimeAdapter(
  paths: Pick<UninstallPaths, "nemoclawStateDir">,
  runtime: OpenRouterRuntimeAdapterCleanupRuntime,
): void {
  const stopped = new Set<number>();

  const pidFile = path.join(paths.nemoclawStateDir, "openrouter-runtime-adapter.pid");
  if (runtime.existsSync(pidFile)) {
    try {
      const raw = fs.readFileSync(pidFile, "utf-8").trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0 && isOpenRouterRuntimeAdapterPid(pid, runtime)) {
        if (tryStopOpenRouterRuntimeAdapterPid(pid, runtime)) stopped.add(pid);
      }
    } catch {
      /* ignore - the State step deletes the file shortly anyway */
    }
  }

  if (!runtime.commandExists("lsof")) {
    if (stopped.size === 0) {
      runtime.warn("lsof not found; skipping orphan OpenRouter Runtime adapter scan.");
    }
    return;
  }

  const adapterPort = resolveOpenRouterRuntimeAdapterPort(runtime);
  const lsof = runtime.run("lsof", ["-ti", `:${adapterPort}`], { env: runtime.env });
  const pids = splitNonEmptyLines(lsof.stdout).map(Number).filter(Number.isFinite);
  for (const pid of pids) {
    if (stopped.has(pid)) continue;
    if (!pidOwnedByCurrentUser(pid, runtime)) continue;
    if (!isOpenRouterRuntimeAdapterPid(pid, runtime)) continue;
    if (tryStopOpenRouterRuntimeAdapterPid(pid, runtime)) stopped.add(pid);
  }

  if (stopped.size === 0) runtime.log("No OpenRouter Runtime adapter processes found");
}
