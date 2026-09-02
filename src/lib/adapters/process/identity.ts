// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { performance } from "node:perf_hooks";

import { isErrnoException } from "../../core/errno";
import { buildSubprocessEnv } from "../../subprocess-env";

const PROCESS_IDENTITY_CACHE_MS = 1_000;

export interface ProcessIdentityProbes {
  readonly currentPid: number;
  isAlive(pid: number): boolean;
  /** Linux boot identity plus start ticks, or null when strong evidence is unavailable. */
  readStrongIdentity(pid: number): string | null;
}

interface LinuxProcessStat {
  readonly state: string;
  readonly startTicks: string | null;
}

const processIdentityCache = new Map<string, { checkedAt: number; identity: string | null }>();

function readLinuxProcessStat(pid: number): LinuxProcessStat | null {
  if (process.platform !== "linux") return null;
  try {
    const statText = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const closeParen = statText.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fieldsAfterComm = statText
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const state = fieldsAfterComm[0];
    const startTicks = fieldsAfterComm[19];
    return state
      ? { state, startTicks: startTicks && /^\d+$/.test(startTicks) ? startTicks : null }
      : null;
  } catch {
    return null;
  }
}

function readLinuxBootIdentity(): string | null {
  try {
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (bootId) return bootId;
  } catch {
    // Fall through to the kernel boot-time record.
  }
  try {
    const bootTime = fs
      .readFileSync("/proc/stat", "utf8")
      .split("\n")
      .find((line) => line.startsWith("btime "))
      ?.trim();
    return bootTime || null;
  } catch {
    return null;
  }
}

/** Treat Linux zombies as departed even though kill(pid, 0) still succeeds. */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (readLinuxProcessStat(pid)?.state === "Z") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

/** Stable machine evidence for lock records shared across host boundaries. */
export function readHostIdentity(): string | null {
  if (process.platform === "linux") {
    for (const candidate of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const machineId = fs.readFileSync(candidate, "utf8").trim();
        if (machineId) return `linux:${machineId}`;
      } catch {
        // Fall through to the next machine identity source.
      }
    }
  }
  if (process.platform === "darwin") {
    try {
      const platform = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
        maxBuffer: 64 * 1024,
      }).toString();
      const platformUuid =
        /"IOPlatformUUID"\s*=\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/iu.exec(
          platform,
        )?.[1];
      return platformUuid ? `darwin:${platformUuid.toLowerCase()}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Linux PID namespace evidence, or null when the host cannot provide it. */
export function readPidNamespaceIdentity(): string | null {
  if (process.platform !== "linux") return null;
  try {
    return fs.readlinkSync("/proc/self/ns/pid");
  } catch {
    return null;
  }
}

/**
 * Read the host process generation used by lifecycle locks. Linux combines
 * the kernel boot identity with process start ticks. Other POSIX hosts use a
 * bounded `ps` fallback unless the caller disables it.
 */
export function readProcessIdentity(
  pid: number,
  fresh = false,
  allowPortableFallback = true,
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const now = performance.now();
  const cacheKey = `${String(pid)}:${allowPortableFallback ? "portable" : "strong"}`;
  const cached = processIdentityCache.get(cacheKey);
  if (
    !fresh &&
    cached &&
    now >= cached.checkedAt &&
    now - cached.checkedAt < PROCESS_IDENTITY_CACHE_MS
  ) {
    return cached.identity;
  }

  let identity: string | null = null;
  if (process.platform === "linux") {
    const processStat = readLinuxProcessStat(pid);
    if (processStat?.startTicks) {
      const bootIdentity = readLinuxBootIdentity();
      if (bootIdentity) identity = `linux:${bootIdentity}:${processStat.startTicks}`;
    }
  } else if (allowPortableFallback) {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: buildSubprocessEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    });
    const startedAt = result.status === 0 ? result.stdout.trim() : "";
    if (startedAt) identity = `${process.platform}:${startedAt}`;
  }

  processIdentityCache.set(cacheKey, { checkedAt: now, identity });
  return identity;
}

/**
 * Read a process-start identity as Linux start ticks, with a bounded portable
 * `ps` fallback. Callers compare the opaque identity without wall-clock
 * conversion or timestamp tolerance.
 */
export function readProcessStartIdentity(pid: number, timeoutMs = 5_000): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const processStat = readLinuxProcessStat(pid);
  if (processStat?.startTicks) return `proc:${processStat.startTicks}`;
  try {
    const timeout = Math.max(1, Math.floor(timeoutMs));
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    })
      .toString()
      .trim();
    return started ? `ps:${started}` : null;
  } catch {
    return null;
  }
}

/** Real host probes used when state logic does not inject deterministic evidence. */
export const hostProcessIdentityProbes: ProcessIdentityProbes = {
  currentPid: process.pid,
  isAlive: processIsAlive,
  // Onboarding never compares second-precision ps timestamps because two
  // generations can begin within the same second. Unavailable strong identity
  // evidence therefore stays fail-closed on non-Linux hosts.
  readStrongIdentity: (pid) => readProcessIdentity(pid, true, false),
};
