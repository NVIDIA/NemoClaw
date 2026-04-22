// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { ensureConfigDir, readConfigFile, writeConfigFile } from "./config-io";

export interface SandboxEntry {
  name: string;
  createdAt?: string;
  model?: string | null;
  nimContainer?: string | null;
  provider?: string | null;
  gpuEnabled?: boolean;
  policies?: string[];
  policyTier?: string | null;
  agent?: string | null;
  dangerouslySkipPermissions?: boolean;
  agentVersion?: string | null;
  imageTag?: string | null;
  providerCredentialHashes?: Record<string, string>;
  messagingChannels?: string[];
  disabledChannels?: string[];
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
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw err;
      let ownerChecked = false;
      try {
        const ownerPid = Number.parseInt(fs.readFileSync(LOCK_OWNER, "utf-8").trim(), 10);
        if (Number.isFinite(ownerPid) && ownerPid > 0) {
          ownerChecked = true;
          let alive: boolean;
          try {
            process.kill(ownerPid, 0);
            alive = true;
          } catch (killErr) {
            alive = (killErr as NodeJS.ErrnoException).code === "EPERM";
          }
          if (!alive) {
            const recheck = Number.parseInt(fs.readFileSync(LOCK_OWNER, "utf-8").trim(), 10);
            if (recheck === ownerPid) {
              fs.rmSync(LOCK_DIR, { recursive: true, force: true });
              continue;
            }
          }
        }
      } catch {
        /* fall through to mtime staleness */
      }
      if (!ownerChecked) {
        try {
          const stat = fs.statSync(LOCK_DIR);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(LOCK_DIR, { recursive: true, force: true });
            continue;
          }
        } catch {
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
      policies: entry.policies || [],
      policyTier: entry.policyTier || null,
      agent: entry.agent || null,
      dangerouslySkipPermissions:
        entry.dangerouslySkipPermissions === true ? true : undefined,
      agentVersion: entry.agentVersion || null,
      imageTag: entry.imageTag || null,
      providerCredentialHashes: entry.providerCredentialHashes || undefined,
      messagingChannels: entry.messagingChannels || [],
      disabledChannels:
        Array.isArray(entry.disabledChannels) && entry.disabledChannels.length > 0
          ? [...entry.disabledChannels]
          : undefined,
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

export function getDisabledChannels(name: string): string[] {
  const data = load();
  return data.sandboxes[name]?.disabledChannels ?? [];
}

export function setChannelDisabled(name: string, channel: string, disabled: boolean): boolean {
  return withLock(() => {
    const data = load();
    const entry = data.sandboxes[name];
    if (!entry) return false;
    const current = new Set(entry.disabledChannels ?? []);
    if (disabled) current.add(channel);
    else current.delete(channel);
    entry.disabledChannels = current.size > 0 ? Array.from(current).sort() : undefined;
    save(data);
    return true;
  });
}
