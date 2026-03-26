// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Preflight checks for NemoClaw onboarding.

const net = require("net");
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
        lsofOut = runCapture(
          `lsof -i :${p} -sTCP:LISTEN -P -n 2>/dev/null`,
          { ignoreError: true }
        );
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
      // Fall through to the net probe which uses bind() at the kernel level.
    }
  }

  // ── net probe fallback ─────────────────────────────────────────
  return probePortAvailability(p, o);
}

module.exports = { checkPortAvailable, probePortAvailability };
