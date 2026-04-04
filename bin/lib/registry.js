// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Multi-sandbox registry at ~/.nemoclaw/sandboxes.json

const fs = require("fs");
const path = require("path");

const REGISTRY_FILE = path.join(process.env.HOME || "/tmp", ".nemoclaw", "sandboxes.json");
const LOCK_DIR = REGISTRY_FILE + ".lock";
const LOCK_OWNER = path.join(LOCK_DIR, "owner");
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 100;
const LOCK_MAX_RETRIES = 120;

/**
 * Acquire an advisory lock using mkdir (atomic on POSIX).
 * Writes an owner file with PID for stale-lock detection via process liveness.
 */
function acquireLock() {
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true, mode: 0o700 });
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      fs.mkdirSync(LOCK_DIR);
      const ownerTmp = LOCK_OWNER + ".tmp." + process.pid;
      try {
        fs.writeFileSync(ownerTmp, String(process.pid), { mode: 0o600 });
        fs.renameSync(ownerTmp, LOCK_OWNER);
      } catch (ownerErr) {
        // Remove the directory we just created so it doesn't look like a stale lock
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
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Check if the lock owner is still alive
      let ownerChecked = false;
      try {
        const ownerPid = parseInt(fs.readFileSync(LOCK_OWNER, "utf-8").trim(), 10);
        if (Number.isFinite(ownerPid) && ownerPid > 0) {
          ownerChecked = true;
          let alive;
          try {
            process.kill(ownerPid, 0);
            alive = true;
          } catch (killErr) {
            // EPERM means the process exists but we lack permission — still alive
            alive = killErr.code === "EPERM";
          }
          if (!alive) {
            // Verify PID hasn't changed (TOCTOU guard)
            const recheck = parseInt(fs.readFileSync(LOCK_OWNER, "utf-8").trim(), 10);
            if (recheck === ownerPid) {
              fs.rmSync(LOCK_DIR, { recursive: true, force: true });
              continue;
            }
          }
        }
        // Owner file empty/corrupt — another process may be mid-write
        // (between mkdirSync and renameSync). Fall through to mtime check.
      } catch {
        // No owner file or lock dir released — fall through to mtime staleness
      }
      if (!ownerChecked) {
        // No valid owner PID available — use mtime as fallback
        try {
          const stat = fs.statSync(LOCK_DIR);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(LOCK_DIR, { recursive: true, force: true });
            continue;
          }
        } catch {
          // Lock was released between our check — retry immediately
          continue;
        }
      }
      Atomics.wait(sleepBuf, 0, 0, LOCK_RETRY_MS);
    }
  }
  throw new Error(`Failed to acquire lock on ${REGISTRY_FILE} after ${LOCK_MAX_RETRIES} retries`);
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_OWNER);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  // rmSync handles leftover tmp files from crashed acquireLock attempts
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

/** Run fn while holding the registry lock.  Returns fn's return value. */
function withLock(fn) {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

function load() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
    }
  } catch {
    /* ignored */
  }
  return { sandboxes: {}, defaultSandbox: null };
}

/** Atomic write: tmp file + rename on the same filesystem. */
function save(data) {
  const dir = path.dirname(REGISTRY_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = REGISTRY_FILE + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, REGISTRY_FILE);
  } catch (err) {
    // Clean up partial temp file on failure
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

function getSandbox(name) {
  const data = load();
  return data.sandboxes[name] || null;
}

function getDefault() {
  const data = load();
  if (data.defaultSandbox && data.sandboxes[data.defaultSandbox]) {
    return data.defaultSandbox;
  }
  // Fall back to first sandbox if default is missing
  const names = Object.keys(data.sandboxes);
  return names.length > 0 ? names[0] : null;
}

function registerSandbox(entry) {
  return withLock(() => {
    const data = load();
    data.sandboxes[entry.name] = {
      name: entry.name,
      createdAt: entry.createdAt || new Date().toISOString(),
      model: entry.model || null,
      nimContainer: entry.nimContainer || null,
      provider: entry.provider || null,
      gpuEnabled: entry.gpuEnabled || false,
      policies: entry.policies || [],
    };
    if (!data.defaultSandbox) {
      data.defaultSandbox = entry.name;
    }
    save(data);
  });
}

function updateSandbox(name, updates) {
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

function removeSandbox(name) {
  return withLock(() => {
    const data = load();
    if (!data.sandboxes[name]) return false;
    delete data.sandboxes[name];
    if (data.defaultSandbox === name) {
      const remaining = Object.keys(data.sandboxes);
      data.defaultSandbox = remaining.length > 0 ? remaining[0] : null;
    }
    save(data);
    return true;
  });
}

function listSandboxes() {
  const data = load();
  return {
    sandboxes: Object.values(data.sandboxes),
    defaultSandbox: data.defaultSandbox,
  };
}

function setDefault(name) {
  return withLock(() => {
    const data = load();
    if (!data.sandboxes[name]) return false;
    data.defaultSandbox = name;
    save(data);
    return true;
  });
}

module.exports = {
  load,
  save,
  getSandbox,
  getDefault,
  registerSandbox,
  updateSandbox,
  removeSandbox,
  listSandboxes,
  setDefault,
  // Exported for testing
  acquireLock,
  releaseLock,
  withLock,
};
