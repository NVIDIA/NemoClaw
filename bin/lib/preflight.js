// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Preflight checks for NemoClaw onboarding.

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { runCapture } = require("./runner");

async function probePortAvailability(port, opts = {}) {
  if (typeof opts.probeImpl === "function") {
    return opts.probeImpl(port);
  }

  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (/** @type {NodeJS.ErrnoException} */ err) => {
      if (err.code === "EADDRINUSE") {
        resolve({
          ok: false,
          process: "unknown",
          pid: null,
          reason: `port ${port} is in use (EADDRINUSE)`,
        });
        return;
      }

      if (err.code === "EPERM" || err.code === "EACCES") {
        resolve({
          ok: true,
          warning: `port probe skipped: ${err.message}`,
        });
        return;
      }

      // Unexpected probe failure: do not report a false conflict.
      resolve({
        ok: true,
        warning: `port probe inconclusive: ${err.message}`,
      });
    });
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve({ ok: true }));
    });
  });
}

/**
 * Check whether a TCP port is available for listening.
 *
 * Detection chain:
 *   1. lsof (primary) — identifies the blocking process name + PID
 *   2. Node.js net probe (fallback) — cross-platform, detects EADDRINUSE
 *
 * opts.lsofOutput — inject fake lsof output for testing (skips shell)
 * opts.skipLsof   — force the net-probe fallback path
 * opts.probeImpl  — async (port) => probe result for testing
 *
 * Returns:
 *   { ok: true }
 *   { ok: true, warning: string }
 *   { ok: false, process: string, pid: number|null, reason: string }
 */
async function checkPortAvailable(port, opts) {
  const p = port || 18789;
  const o = opts || {};

  // ── lsof path ──────────────────────────────────────────────────
  if (!o.skipLsof) {
    let lsofOut;
    if (typeof o.lsofOutput === "string") {
      lsofOut = o.lsofOutput;
    } else {
      const hasLsof = runCapture("command -v lsof", { ignoreError: true });
      if (hasLsof) {
        lsofOut = runCapture(`lsof -i :${p} -sTCP:LISTEN -P -n 2>/dev/null`, { ignoreError: true });
      }
    }

    if (typeof lsofOut === "string") {
      const lines = lsofOut.split("\n").filter((l) => l.trim());
      // Skip the header line (starts with COMMAND)
      const dataLines = lines.filter((l) => !l.startsWith("COMMAND"));
      if (dataLines.length > 0) {
        // Parse first data line: COMMAND PID USER ...
        const parts = dataLines[0].split(/\s+/);
        const proc = parts[0] || "unknown";
        const pid = parseInt(parts[1], 10) || null;
        return {
          ok: false,
          process: proc,
          pid,
          reason: `lsof reports ${proc} (PID ${pid}) listening on port ${p}`,
        };
      }
      // Empty lsof output is not authoritative — non-root users cannot
      // see listeners owned by root (e.g., docker-proxy, leftover gateway).
      // Retry with sudo to identify root-owned listeners before falling
      // through to the net probe (which can only detect EADDRINUSE but not
      // the owning process).
      if (dataLines.length === 0 && !o.lsofOutput) {
        const sudoOut = runCapture(`sudo -n lsof -i :${p} -sTCP:LISTEN -P -n 2>/dev/null`, {
          ignoreError: true,
        });
        if (typeof sudoOut === "string") {
          const sudoLines = sudoOut.split("\n").filter((l) => l.trim());
          const sudoData = sudoLines.filter((l) => !l.startsWith("COMMAND"));
          if (sudoData.length > 0) {
            const parts = sudoData[0].split(/\s+/);
            const proc = parts[0] || "unknown";
            const pid = parseInt(parts[1], 10) || null;
            return {
              ok: false,
              process: proc,
              pid,
              reason: `sudo lsof reports ${proc} (PID ${pid}) listening on port ${p}`,
            };
          }
        }
      }
    }
  }

  // ── net probe fallback ─────────────────────────────────────────
  return probePortAvailability(p, o);
}

/**
 * Read system memory info (RAM + swap).
 *
 * On Linux, parses /proc/meminfo. On macOS, uses sysctl.
 * Returns null on unsupported platforms or read errors.
 *
 * opts.meminfoContent — inject fake /proc/meminfo for testing
 * opts.platform       — override process.platform for testing
 *
 * Returns:
 *   { totalRamMB: number, totalSwapMB: number, totalMB: number }
 */
function getMemoryInfo(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;

  if (platform === "linux") {
    let content;
    if (typeof o.meminfoContent === "string") {
      content = o.meminfoContent;
    } else {
      try {
        content = fs.readFileSync("/proc/meminfo", "utf-8");
      } catch {
        return null;
      }
    }

    const parseKB = (key) => {
      const match = content.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
      return match ? parseInt(match[1], 10) : 0;
    };

    const totalRamKB = parseKB("MemTotal");
    const totalSwapKB = parseKB("SwapTotal");
    const totalRamMB = Math.floor(totalRamKB / 1024);
    const totalSwapMB = Math.floor(totalSwapKB / 1024);
    return { totalRamMB, totalSwapMB, totalMB: totalRamMB + totalSwapMB };
  }

  if (platform === "darwin") {
    try {
      const memBytes = parseInt(runCapture("sysctl -n hw.memsize", { ignoreError: true }), 10);
      if (!memBytes || isNaN(memBytes)) return null;
      const totalRamMB = Math.floor(memBytes / 1024 / 1024);
      // macOS does not use traditional swap files in the same way
      return { totalRamMB, totalSwapMB: 0, totalMB: totalRamMB };
    } catch {
      return null;
    }
  }

  return null;
}

function hasSwapfile() {
  try {
    fs.accessSync("/swapfile");
    return true;
  } catch {
    return false;
  }
}

function getExistingSwapResult(mem) {
  if (!hasSwapfile()) {
    return null;
  }

  const swaps = (() => {
    try {
      return fs.readFileSync("/proc/swaps", "utf-8");
    } catch {
      return "";
    }
  })();

  if (swaps.includes("/swapfile")) {
    return {
      ok: true,
      totalMB: mem.totalMB,
      swapCreated: false,
      reason: "/swapfile already exists",
    };
  }

  try {
    runCapture("sudo swapon /swapfile", { ignoreError: false });
    return { ok: true, totalMB: mem.totalMB + 4096, swapCreated: true };
  } catch (err) {
    return {
      ok: false,
      reason: `found orphaned /swapfile but could not activate it: ${err.message}`,
    };
  }
}

function checkSwapDiskSpace() {
  try {
    const dfOut = runCapture("df / --output=avail -k 2>/dev/null | tail -1", { ignoreError: true });
    const freeKB = parseInt((dfOut || "").trim(), 10);
    if (!isNaN(freeKB) && freeKB < 5000000) {
      return {
        ok: false,
        reason: `insufficient disk space (${Math.floor(freeKB / 1024)} MB free, need ~5 GB) to create swap file`,
      };
    }
  } catch {
    // df unavailable — let dd fail naturally if out of space
  }

  return null;
}

function writeManagedSwapMarker() {
  const nemoclawDir = path.join(os.homedir(), ".nemoclaw");
  if (!fs.existsSync(nemoclawDir)) {
    runCapture(`mkdir -p ${nemoclawDir}`, { ignoreError: true });
  }

  try {
    fs.writeFileSync(path.join(nemoclawDir, "managed_swap"), "/swapfile");
  } catch {
    // Best effort marker write.
  }
}

function cleanupPartialSwap() {
  try {
    runCapture("sudo swapoff /swapfile 2>/dev/null || true", { ignoreError: true });
    runCapture("sudo rm -f /swapfile", { ignoreError: true });
  } catch {
    // Best effort cleanup
  }
}

function createSwapfile(mem) {
  try {
    runCapture("sudo dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none", {
      ignoreError: false,
    });
    runCapture("sudo chmod 600 /swapfile", { ignoreError: false });
    runCapture("sudo mkswap /swapfile", { ignoreError: false });
    runCapture("sudo swapon /swapfile", { ignoreError: false });
    runCapture(
      "grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab",
      { ignoreError: false },
    );
    writeManagedSwapMarker();

    return { ok: true, totalMB: mem.totalMB + 4096, swapCreated: true };
  } catch (err) {
    cleanupPartialSwap();
    return {
      ok: false,
      reason:
        `swap creation failed: ${err.message}. Create swap manually:\n` +
        "  sudo dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none && sudo chmod 600 /swapfile && " +
        "sudo mkswap /swapfile && sudo swapon /swapfile",
    };
  }
}

/**
 * Ensure the system has enough memory (RAM + swap) for sandbox operations.
 *
 * If total memory is below minTotalMB and no swap file exists, attempts to
 * create a 4 GB swap file via sudo to prevent OOM kills during sandbox image push.
 *
 * opts.memoryInfo — inject mock getMemoryInfo() result for testing
 * opts.platform   — override process.platform for testing
 * opts.dryRun     — if true, skip actual swap creation (for testing)
 *
 * Returns:
 *   { ok: true, totalMB, swapCreated: boolean }
 *   { ok: false, reason: string }
 */
function ensureSwap(minTotalMB, opts = {}) {
  const o = {
    platform: process.platform,
    memoryInfo: null,
    swapfileExists: fs.existsSync("/swapfile"),
    dryRun: false,
    interactive: process.stdout.isTTY && !process.env.NEMOCLAW_NON_INTERACTIVE,
    getMemoryInfoImpl: getMemoryInfo,
    ...opts,
  };
  const threshold = minTotalMB ?? 12000;

  if (o.platform !== "linux") {
    return { ok: true, totalMB: 0, swapCreated: false };
  }

  const mem = o.memoryInfo ?? o.getMemoryInfoImpl({ platform: o.platform });
  if (!mem) {
    return { ok: false, reason: "could not read memory info" };
  }

  if (mem.totalMB >= threshold) {
    return { ok: true, totalMB: mem.totalMB, swapCreated: false };
  }

  if (o.dryRun) {
    if (o.swapfileExists) {
      return {
        ok: true,
        totalMB: mem.totalMB,
        swapCreated: false,
        reason: "/swapfile already exists",
      };
    }
    return { ok: true, totalMB: mem.totalMB, swapCreated: true };
  }

  const existingSwapResult = getExistingSwapResult(mem);
  if (existingSwapResult) {
    return existingSwapResult;
  }

  const diskSpaceResult = checkSwapDiskSpace();
  if (diskSpaceResult) {
    return diskSpaceResult;
  }

  return createSwapfile(mem);
}

module.exports = { checkPortAvailable, probePortAvailability, getMemoryInfo, ensureSwap };
