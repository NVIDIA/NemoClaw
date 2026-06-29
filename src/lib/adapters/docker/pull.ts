// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnOptions } from "node:child_process";

import { ROOT } from "../../runner";
import { buildSubprocessEnv } from "../../subprocess-env";
import { dockerSpawn } from "./exec";
import { dockerRun, type DockerRunOptions, type DockerRunResult } from "./run";

export function dockerPull(imageRef: string, opts: DockerRunOptions = {}): DockerRunResult {
  return dockerRun(["pull", imageRef], opts);
}

export const DEFAULT_DOCKER_PULL_STALL_TIMEOUT_MS = 120 * 1000;
export const DEFAULT_DOCKER_PULL_MAX_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const DOCKER_PULL_OUTPUT_TAIL_LINES = 200;
const DOCKER_PULL_PROGRESS_STATE_LIMIT = 512;

export interface DockerPullWatchdogOptions {
  suppressOutput?: boolean;
  stallTimeoutMs?: number;
  maxTimeoutMs?: number;
  watchdogIntervalMs?: number;
  logLine?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: (args: readonly string[], options: SpawnOptions) => DockerPullChildProcess;
}

export interface DockerPullWatchdogResult {
  status: number;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
  timeoutKind: "stall" | "max" | null;
  error?: Error;
}

export interface DockerPullReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
}

export interface DockerPullChildProcess {
  stdout: DockerPullReadable | null;
  stderr: DockerPullReadable | null;
  kill?(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export function dockerPullProgressSignature(line: string): string | null {
  const normalized = line.trim().replace(/\s+/g, " ");
  if (!normalized) return null;

  const layerMatch = normalized.match(
    /^([a-f0-9]{6,}):\s+([A-Za-z][A-Za-z ]*?)(?=\s+\[|\s+[\d.]+\s*[A-Za-z]+\s*\/|$)(?:\s+\[[^\]]*\])?(?:\s+([\d.]+\s*[A-Za-z]+)\s*\/\s*([\d.]+\s*[A-Za-z]+))?/,
  );
  if (layerMatch) {
    const layer = layerMatch[1];
    const phase = layerMatch[2].trim();
    const completed = layerMatch[3]?.replace(/\s+/g, "");
    const total = layerMatch[4]?.replace(/\s+/g, "");
    return completed && total
      ? `layer:${layer}:${phase}:${completed}/${total}`
      : `layer:${layer}:${phase}`;
  }

  if (/^(?:[^:\s]+:\s+)?Pulling from \S+/.test(normalized)) {
    return `source:${normalized}`;
  }
  if (/^Digest: sha256:[a-f0-9]{8,}/.test(normalized)) {
    return `digest:${normalized}`;
  }
  if (/^Status: /.test(normalized)) {
    return `status:${normalized}`;
  }

  // This vLLM watchdog intentionally recognizes observed `docker pull`
  // layer/status output only; BuildKit-style build output is not pull progress.
  return null;
}

function dockerPullProgressKey(signature: string): string {
  const layerMatch = signature.match(/^layer:([^:]+):([^:]+)(?::.*)?$/);
  if (layerMatch) return `layer:${layerMatch[1]}:${layerMatch[2]}`;
  if (signature.startsWith("source:")) return "source";
  if (signature.startsWith("digest:")) return "digest";
  if (signature.startsWith("status:")) return "status";
  return signature;
}

export async function dockerPullWithProgressWatchdog(
  imageRef: string,
  opts: DockerPullWatchdogOptions = {},
): Promise<DockerPullWatchdogResult> {
  const stallTimeoutMs = positiveMs(opts.stallTimeoutMs, DEFAULT_DOCKER_PULL_STALL_TIMEOUT_MS);
  const maxTimeoutMs = positiveMs(opts.maxTimeoutMs, DEFAULT_DOCKER_PULL_MAX_TIMEOUT_MS);
  const watchdogIntervalMs = positiveMs(
    opts.watchdogIntervalMs,
    Math.min(1000, Math.max(100, Math.floor(stallTimeoutMs / 4))),
  );
  const logLine = opts.logLine ?? ((line: string) => process.stderr.write(`${line}\n`));
  const spawnImpl =
    opts.spawnImpl ??
    ((args: readonly string[], options: SpawnOptions) =>
      dockerSpawn(args, options) as DockerPullChildProcess);
  const child = spawnImpl(["pull", imageRef], {
    cwd: ROOT,
    env: buildSubprocessEnv(normalizeExtraEnv(opts.env)),
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve) => {
    const lines: string[] = [];
    const latestProgressByKey = new Map<string, string>();
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    let stdoutPending = "";
    let stderrPending = "";
    let settled = false;
    let timeoutKind: "stall" | "max" | null = null;
    let capturedError: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | null = null;

    function noteProgress(line: string) {
      const signature = dockerPullProgressSignature(line);
      if (!signature) return;
      const key = dockerPullProgressKey(signature);
      if (latestProgressByKey.get(key) === signature) return;
      latestProgressByKey.delete(key);
      latestProgressByKey.set(key, signature);
      while (latestProgressByKey.size > DOCKER_PULL_PROGRESS_STATE_LIMIT) {
        const oldestKey = latestProgressByKey.keys().next().value;
        if (oldestKey === undefined) break;
        latestProgressByKey.delete(oldestKey);
      }
      lastProgressAt = Date.now();
    }

    function rememberLine(line: string) {
      lines.push(line);
      if (lines.length > DOCKER_PULL_OUTPUT_TAIL_LINES) {
        lines.splice(0, lines.length - DOCKER_PULL_OUTPUT_TAIL_LINES);
      }
    }

    function flushLine(line: string) {
      const trimmed = line.trimEnd();
      if (!trimmed) return;
      rememberLine(trimmed);
      noteProgress(trimmed);
      if (!opts.suppressOutput) logLine(trimmed);
    }

    function consumeChunk(pending: string, chunk: Buffer | string): string {
      const text = pending + chunk.toString();
      const parts = text.split(/[\r\n]+/);
      const nextPending = parts.pop() ?? "";
      for (const part of parts) flushLine(part);
      return nextPending;
    }

    function flushPending() {
      if (stdoutPending) {
        flushLine(stdoutPending);
        stdoutPending = "";
      }
      if (stderrPending) {
        flushLine(stderrPending);
        stderrPending = "";
      }
    }

    function requestKill(kind: "stall" | "max") {
      if (settled || timeoutKind) return;
      timeoutKind = kind;
      const detail =
        kind === "stall"
          ? `docker pull stalled after ${formatSeconds(stallTimeoutMs)} without progress`
          : `docker pull exceeded maximum safety budget ${formatSeconds(maxTimeoutMs)}`;
      rememberLine(detail);
      if (!opts.suppressOutput) logLine(`  ${detail}`);
      try {
        child.kill?.("SIGTERM");
      } catch {
        /* best effort */
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill?.("SIGKILL");
        } catch {
          /* best effort */
        }
      }, 5000);
      forceKillTimer.unref?.();
    }

    const watchdog = setInterval(() => {
      const now = Date.now();
      if (now - lastProgressAt >= stallTimeoutMs) {
        requestKill("stall");
        return;
      }
      if (now - startedAt >= maxTimeoutMs) {
        requestKill("max");
      }
    }, watchdogIntervalMs);
    watchdog.unref?.();

    function finish(code: number | null, signal: NodeJS.Signals | null) {
      if (settled) return;
      settled = true;
      flushPending();
      clearInterval(watchdog);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const status = code ?? (timeoutKind ? 124 : 1);
      const result: DockerPullWatchdogResult = {
        status,
        signal,
        output: lines.join("\n"),
        timedOut: timeoutKind !== null,
        timeoutKind,
        ...(capturedError ? { error: capturedError } : {}),
      };
      resolve(result);
    }

    child.stdout?.on("data", (chunk) => {
      stdoutPending = consumeChunk(stdoutPending, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrPending = consumeChunk(stderrPending, chunk);
    });
    child.on("error", (error: Error) => {
      capturedError = error;
      rememberLine(`docker pull failed to start: ${error.message}`);
      finish(1, null);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      finish(code, signal);
    });
  });
}

function normalizeExtraEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) normalized[key] = value;
  }
  return normalized;
}

function positiveMs(value: number | undefined, fallbackMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallbackMs;
  return value < 1 ? 1 : Math.floor(value);
}

function formatSeconds(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds}s`;
}
