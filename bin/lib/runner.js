// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");

/**
 * Detect a container runtime socket (Colima first, then Podman).
 * Returns the socket path or null.
 *
 * @param {object} [opts] — DI overrides for testing
 * @param {string} [opts.home] — HOME directory override
 * @param {function} [opts.existsSync] — fs.existsSync override
 * @param {number} [opts.uid] — process UID override for rootless Podman
 */
function detectContainerSocket(opts) {
  const home = (opts && opts.home) || process.env.HOME || "/tmp";
  const exists = (opts && opts.existsSync) || fs.existsSync;
  const uid = (opts && opts.uid !== undefined) ? opts.uid : (process.getuid ? process.getuid() : 1000);

  const candidates = [
    // Colima (preferred — existing behavior)
    path.join(home, ".colima/default/docker.sock"),
    path.join(home, ".config/colima/default/docker.sock"),
    // Podman machine
    path.join(home, ".local/share/containers/podman/machine/podman.sock"),
    `/run/user/${uid}/podman/podman.sock`,
    path.join(home, ".local/share/containers/podman/machine/qemu/podman.sock"),
  ];

  for (const sock of candidates) {
    if (exists(sock)) {
      return sock;
    }
  }
  return null;
}

// Auto-detect container socket if DOCKER_HOST not already set
if (!process.env.DOCKER_HOST) {
  const sock = detectContainerSocket();
  if (sock) {
    process.env.DOCKER_HOST = `unix://${sock}`;
  }
}

/** @param {string} cmd - Shell command to execute. @param {object} [opts] */
function run(cmd, opts = {}) {
  const result = spawnSync("bash", ["-c", cmd], {
    stdio: "inherit",
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    ...opts,
  });
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(`  Command failed (exit ${result.status}): ${cmd.slice(0, 80)}`);
    process.exit(result.status || 1);
  }
  return result;
}

/** @param {string} cmd - Shell command. @returns {string} Trimmed stdout. */
function runCapture(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      cwd: ROOT,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    }).trim();
  } catch (err) {
    if (opts.ignoreError) return "";
    throw err;
  }
}

module.exports = { ROOT, SCRIPTS, run, runCapture, detectContainerSocket };
