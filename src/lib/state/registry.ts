// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { isErrnoException } from "../core/errno";
import { ensureConfigDir, readConfigFile, writeConfigFile } from "./config-io";
import {
  cloneSandboxMessagingState,
  getConfiguredMessagingChannels as getRegistryConfiguredMessagingChannels,
  getDisabledChannels as getRegistryDisabledChannels,
  setChannelDisabled as setRegistryChannelDisabled,
} from "./registry-messaging";
import type { SandboxMessagingState } from "./registry-messaging";
export {
  getActiveMessagingChannelsFromEntry,
  getConfiguredMessagingChannelsFromEntry,
  getDisabledMessagingChannelsFromEntry,
  getMessagingPlanFromEntry,
  type SandboxMessagingState,
} from "./registry-messaging";

export interface CustomPolicyEntry {
  name: string;
  content: string;
  sourcePath?: string;
  appliedAt?: string;
}

// Outcome of the last live sandbox GPU proof run during onboarding/recovery.
// `status` separates a configured-but-unverified GPU from one whose CUDA
// usability was actually proven (`verified`) or actively failed a live proof
// (`failed`, e.g. Jetson `/dev/nvmap` permission errors). Persisted so
// `nemoclaw <sandbox> status` can report proof state instead of treating any
// configured GPU as healthy (#4231).
export type SandboxGpuProofStatus = "verified" | "unverified" | "failed";

export interface SandboxGpuProofResult {
  status: SandboxGpuProofStatus;
  // True only when a CUDA-usability proof (cuInit via libcuda) actually passed.
  cudaVerified: boolean;
  // Label of the last proof that determined `status`.
  label?: string | null;
  // Redacted, truncated diagnostic captured when the proof failed.
  detail?: string | null;
  at: string;
}

export interface SandboxEntry {
  name: string;
  createdAt?: string;
  model?: string | null;
  nimContainer?: string | null;
  provider?: string | null;
  gpuEnabled?: boolean;
  hostGpuDetected?: boolean;
  sandboxGpuEnabled?: boolean;
  sandboxGpuMode?: "auto" | "1" | "0" | string | null;
  sandboxGpuDevice?: string | null;
  sandboxGpuProof?: SandboxGpuProofResult | null;
  openshellDriver?: string | null;
  openshellVersion?: string | null;
  policies?: string[];
  customPolicies?: CustomPolicyEntry[];
  policyTier?: string | null;
  // True once the onboard policy step has fully completed and reconciled the
  // effective preset selection (set by the post-policy registry write). Absent
  // on a sandbox whose registration recorded only boot-time presets but whose
  // policy step never finished — so re-onboard knows whether `policies`
  // represents a final selection it can carry forward. See #4621.
  policyPresetsFinalized?: boolean;
  agent?: string | null;
  agentVersion?: string | null;
  // NemoClaw build fingerprint (the NemoClaw CLI/build version) stamped only on
  // NemoClaw-managed images at create/rebuild time. `upgrade-sandboxes` compares
  // it against the running NemoClaw build so an image/build change with an
  // unchanged agent version is still detected as needing a rebuild. Custom-image
  // (`--from`) sandboxes are intentionally left without a fingerprint so they
  // are never auto-rebuilt onto the default image (#5026).
  nemoclawVersion?: string | null;
  imageTag?: string | null;
  providerCredentialHashes?: Record<string, string>;
  messaging?: SandboxMessagingState;
  hermesToolGateways?: string[];
  hermesDashboardEnabled?: boolean;
  hermesDashboardPort?: number | null;
  hermesDashboardInternalPort?: number | null;
  hermesDashboardTui?: boolean;
  dashboardPort?: number | null;
  // OpenShell gateway registration name and host port bound to this sandbox.
  // Persisted so later lifecycle commands operate on the sandbox's own gateway
  // instead of the process-global `nemoclaw` singleton — a second sandbox on a
  // different NEMOCLAW_GATEWAY_PORT no longer recreates/kills the first (#4422).
  gatewayName?: string | null;
  gatewayPort?: number | null;
}

export interface SandboxRegistry {
  sandboxes: Record<string, SandboxEntry>;
  defaultSandbox: string | null;
}

export const REGISTRY_FILE = path.join(process.env.HOME || "/tmp", ".nemoclaw", "sandboxes.json");
export const LOCK_DIR = `${REGISTRY_FILE}.lock`;
export const LOCK_OWNER = path.join(LOCK_DIR, "owner");
export const LOCK_STALE_MS = 10_000;
export const LOCK_RETRY_MS = 100;
export const LOCK_MAX_RETRIES = 120;

/** kill(pid, 0) liveness probe. EPERM means the pid exists but is owned by
 * another user, which still counts as alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

/** Wall-clock start time (ms since epoch) of `pid` from /proc, or null when it
 * cannot be read (process gone, or a non-Linux host without /proc). Mirrors the
 * onboard-session lock's recycle check. */
function readProcessStartMs(pid: number): number | null {
  try {
    const statText = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const btimeLine = fs
      .readFileSync("/proc/stat", "utf8")
      .split("\n")
      .find((line) => line.startsWith("btime "));
    const bootSeconds = btimeLine ? Number(btimeLine.trim().split(/\s+/)[1]) : NaN;
    const closeParen = statText.lastIndexOf(")");
    if (!Number.isFinite(bootSeconds) || closeParen < 0) return null;
    const fieldsAfterComm = statText
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const startTicks = Number(fieldsAfterComm[19]);
    if (!Number.isFinite(startTicks)) return null;
    // /proc/<pid>/stat starttime is in USER_HZ ticks (100 on supported hosts).
    const clockTicksPerSecond = 100;
    return (bootSeconds + startTicks / clockTicksPerSecond) * 1000;
  } catch {
    return null;
  }
}

export type RegistryLockDecision = "break" | "wait";

/**
 * Decide whether an existing registry lock should be broken (stale) or waited
 * on. Exported for tests.
 *
 * The PID-recycle wedge this guards against: a holder that crashes without
 * releasing leaves `LOCK_DIR` + the owner pid behind. If that pid is later
 * reused by an unrelated live process, `kill(pid, 0)` succeeds, so a
 * liveness-only check treats the lock as held forever and every registry write
 * wedges (retries exhausted -> "Failed to acquire lock"). When the owner looks
 * alive we therefore also confirm it started BEFORE it took the lock: a process
 * whose /proc start time is after the lock's mtime is a recycled pid, so the
 * lock is stale. When the owner pid or its start time cannot be read (missing
 * owner file, non-Linux host), fall back to breaking the lock once it is older
 * than a registry op could legitimately take.
 */
export function classifyExistingLock(opts: {
  ownerPid: number | null;
  ownerAlive: boolean;
  processStartMs: number | null;
  lockMtimeMs: number;
  nowMs: number;
  staleMs: number;
}): RegistryLockDecision {
  const ageMs = opts.nowMs - opts.lockMtimeMs;
  if (opts.ownerPid === null) {
    // Owner file missing or unreadable: decide on age alone.
    return ageMs > opts.staleMs ? "break" : "wait";
  }
  if (!opts.ownerAlive) {
    return "break";
  }
  if (opts.processStartMs !== null && opts.processStartMs > opts.lockMtimeMs + 1000) {
    // Live pid that started after the lock was taken -> the pid was recycled.
    return "break";
  }
  // Live original holder (or start time unknown): only break once the lock is
  // clearly older than a registry op could take, which also covers hosts where
  // recycle cannot be detected directly.
  return ageMs > opts.staleMs ? "break" : "wait";
}

/** Acquire an advisory lock using mkdir (atomic on POSIX). */
export function acquireLock(): void {
  ensureConfigDir(path.dirname(REGISTRY_FILE));
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      fs.mkdirSync(LOCK_DIR);
      const ownerTmp = `${LOCK_OWNER}.tmp.${process.pid}`;
      try {
        fs.writeFileSync(ownerTmp, String(process.pid), { mode: 0o600 });
        fs.renameSync(ownerTmp, LOCK_OWNER);
      } catch (ownerErr) {
        try {
          fs.unlinkSync(ownerTmp);
        } catch {
          /* best effort */
        }
        try {
          fs.unlinkSync(LOCK_OWNER);
        } catch {
          /* best effort */
        }
        try {
          fs.rmdirSync(LOCK_DIR);
        } catch {
          /* best effort */
        }
        throw ownerErr;
      }
      return;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") {
        throw error;
      }
      let lockStat: fs.Stats;
      try {
        lockStat = fs.statSync(LOCK_DIR);
      } catch {
        // Lock dir vanished between the failed mkdir and this stat: another
        // waiter released it, so retry immediately.
        continue;
      }
      let ownerPid: number | null = null;
      try {
        const parsed = Number.parseInt(fs.readFileSync(LOCK_OWNER, "utf-8").trim(), 10);
        ownerPid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      } catch {
        ownerPid = null;
      }
      const ownerAlive = ownerPid !== null ? isProcessAlive(ownerPid) : false;
      const processStartMs = ownerPid !== null && ownerAlive ? readProcessStartMs(ownerPid) : null;
      const decision = classifyExistingLock({
        ownerPid,
        ownerAlive,
        processStartMs,
        lockMtimeMs: lockStat.mtimeMs,
        nowMs: Date.now(),
        staleMs: LOCK_STALE_MS,
      });
      if (decision === "break") {
        // Only break the lock if it is provably the same one we classified.
        // Re-stat LOCK_DIR and require the inode + mtime to be unchanged (a
        // replacement lock is a fresh mkdir, hence a new inode) and, when the
        // owner pid was readable, that it still matches. Any stat/read failure
        // means the identity cannot be proven, so the lock is left alone rather
        // than risk clobbering an in-flight replacement that exists as LOCK_DIR
        // before its owner file has been written.
        let stillSameLock = false;
        try {
          const currentStat = fs.statSync(LOCK_DIR);
          stillSameLock =
            currentStat.ino === lockStat.ino && currentStat.mtimeMs === lockStat.mtimeMs;
          if (stillSameLock && ownerPid !== null) {
            const recheck = Number.parseInt(fs.readFileSync(LOCK_OWNER, "utf-8").trim(), 10);
            stillSameLock = recheck === ownerPid;
          }
        } catch {
          stillSameLock = false;
        }
        if (stillSameLock) {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      }
      Atomics.wait(sleepBuf, 0, 0, LOCK_RETRY_MS);
    }
  }
  throw new Error(`Failed to acquire lock on ${REGISTRY_FILE} after ${LOCK_MAX_RETRIES} retries`);
}

export function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_OWNER);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

export function withLock<T>(fn: () => T): T {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

export function load(): SandboxRegistry {
  return readConfigFile<SandboxRegistry>(REGISTRY_FILE, { sandboxes: {}, defaultSandbox: null });
}

export function save(data: SandboxRegistry): void {
  writeConfigFile(REGISTRY_FILE, data);
}

export function getSandbox(name: string): SandboxEntry | null {
  const data = load();
  return data.sandboxes[name] || null;
}

export function getDefault(): string | null {
  const data = load();
  if (data.defaultSandbox && data.sandboxes[data.defaultSandbox]) {
    return data.defaultSandbox;
  }
  const names = Object.keys(data.sandboxes);
  return names.length > 0 ? names[0] || null : null;
}

export function registerSandbox(entry: SandboxEntry): void {
  withLock(() => {
    const data = load();
    data.sandboxes[entry.name] = {
      name: entry.name,
      createdAt: entry.createdAt || new Date().toISOString(),
      model: entry.model || null,
      nimContainer: entry.nimContainer || null,
      provider: entry.provider || null,
      gpuEnabled: entry.gpuEnabled || false,
      hostGpuDetected: entry.hostGpuDetected === true,
      sandboxGpuEnabled: entry.sandboxGpuEnabled === true,
      sandboxGpuMode: entry.sandboxGpuMode || null,
      sandboxGpuDevice: entry.sandboxGpuDevice || null,
      sandboxGpuProof: entry.sandboxGpuProof ?? null,
      openshellDriver: entry.openshellDriver || null,
      openshellVersion: entry.openshellVersion || null,
      policies: entry.policies || [],
      policyTier: entry.policyTier || null,
      // policyPresetsFinalized is intentionally not set here: registration means
      // the policy step has not completed for this entry. It is stamped only by
      // the post-policy registry write (see policy-preset-persistence), so a
      // snapshot clone (which spreads the source entry but resets `policies`)
      // cannot inherit a stale finalized marker. See #4621.
      agent: entry.agent || null,
      agentVersion: entry.agentVersion || null,
      nemoclawVersion: entry.nemoclawVersion || null,
      imageTag: entry.imageTag || null,
      providerCredentialHashes: entry.providerCredentialHashes || undefined,
      messaging: cloneSandboxMessagingState(entry.messaging),
      hermesToolGateways:
        Array.isArray(entry.hermesToolGateways) && entry.hermesToolGateways.length > 0
          ? [...entry.hermesToolGateways]
          : undefined,
      hermesDashboardEnabled: entry.hermesDashboardEnabled === true ? true : undefined,
      hermesDashboardPort: entry.hermesDashboardPort ?? undefined,
      hermesDashboardInternalPort: entry.hermesDashboardInternalPort ?? undefined,
      hermesDashboardTui: entry.hermesDashboardTui === true ? true : undefined,
      dashboardPort: entry.dashboardPort ?? undefined,
      gatewayName: entry.gatewayName ?? undefined,
      gatewayPort: entry.gatewayPort ?? undefined,
    };
    if (!data.defaultSandbox) {
      data.defaultSandbox = entry.name;
    }
    save(data);
  });
}

export function updateSandbox(name: string, updates: Partial<SandboxEntry>): boolean {
  return withLock(() => {
    const data = load();
    if (!data.sandboxes[name]) return false;
    if (Object.prototype.hasOwnProperty.call(updates, "name") && updates.name !== name) {
      return false;
    }
    Object.assign(data.sandboxes[name], updates);
    save(data);
    return true;
  });
}

export function removeSandbox(name: string): boolean {
  return withLock(() => {
    const data = load();
    if (!data.sandboxes[name]) return false;
    delete data.sandboxes[name];
    if (data.defaultSandbox === name) {
      const remaining = Object.keys(data.sandboxes);
      data.defaultSandbox = remaining.length > 0 ? remaining[0] || null : null;
    }
    save(data);
    return true;
  });
}

/**
 * Restore a previously-removed sandbox entry verbatim under the registry lock,
 * preserving every field exactly (unlike `registerSandbox`, which rebuilds a
 * fresh entry from known fields). Used to roll back a failed stale-sandbox
 * rebuild recovery (#4497): the entry was removed before the recreate, and on
 * failure it must come back intact. Operates on the CURRENT registry (it does
 * not clobber other sandboxes' entries another command added during the rebuild
 * window).
 *
 * `reclaimDefault` undoes the default-pointer move the original `removeSandbox`
 * performed: when this sandbox was the default, `removeSandbox` reassigned
 * `defaultSandbox` to another remaining sandbox (or null), so the rollback puts
 * it back. This is best-effort "undo my operation" — a deliberate default change
 * by a concurrent command during the rebuild window is an inherent race and may
 * be overwritten.
 */
export function restoreSandboxEntry(
  entry: SandboxEntry,
  options: { reclaimDefault?: string | null } = {},
): void {
  withLock(() => {
    const data = load();
    data.sandboxes[entry.name] = entry;
    if (options.reclaimDefault && data.defaultSandbox !== options.reclaimDefault) {
      data.defaultSandbox = options.reclaimDefault;
    }
    save(data);
  });
}

export function listSandboxes(): { sandboxes: SandboxEntry[]; defaultSandbox: string | null } {
  const data = load();
  return {
    sandboxes: Object.values(data.sandboxes),
    defaultSandbox: data.defaultSandbox,
  };
}

export function setDefault(name: string): boolean {
  return withLock(() => {
    const data = load();
    if (!data.sandboxes[name]) return false;
    data.defaultSandbox = name;
    save(data);
    return true;
  });
}

export function clearAll(): void {
  withLock(() => {
    save({ sandboxes: {}, defaultSandbox: null });
  });
}

/** Return the list of custom policy entries recorded for a sandbox (never null). */
export function getCustomPolicies(name: string): CustomPolicyEntry[] {
  const data = load();
  return data.sandboxes[name]?.customPolicies ?? [];
}

/** Upsert a custom policy by name. Replaces any existing entry with the same name. */
export function addCustomPolicy(name: string, entry: CustomPolicyEntry): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    if (!sandbox) return false;
    const list = (sandbox.customPolicies ?? []).filter((p) => p.name !== entry.name);
    list.push({ ...entry, appliedAt: entry.appliedAt ?? new Date().toISOString() });
    sandbox.customPolicies = list;
    save(data);
    return true;
  });
}

/** Remove a custom policy by name. Returns true if an entry was removed. */
export function removeCustomPolicyByName(name: string, presetName: string): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    if (!sandbox) return false;
    const list = sandbox.customPolicies ?? [];
    const next = list.filter((p) => p.name !== presetName);
    if (next.length === list.length) return false;
    sandbox.customPolicies = next.length > 0 ? next : undefined;
    save(data);
    return true;
  });
}

export function getDisabledChannels(name: string): string[] {
  return getRegistryDisabledChannels(name, { load });
}

export function getConfiguredMessagingChannels(name: string): string[] {
  return getRegistryConfiguredMessagingChannels(name, { load });
}

export function setChannelDisabled(name: string, channel: string, disabled: boolean): boolean {
  return setRegistryChannelDisabled(name, channel, disabled, { load, save, withLock });
}
