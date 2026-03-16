// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Preflight checks for NemoClaw onboarding.

const fs = require("fs");
const { runCapture } = require("./runner");

const DEFAULT_DAEMON_JSON = "/etc/docker/daemon.json";

/**
 * Detect if the host uses cgroup v2.
 *
 * Returns true when /sys/fs/cgroup is mounted as cgroup2fs.
 * stat -fc is GNU coreutils (Linux). On macOS/BSD this command does not
 * exist, so the platform guard ensures we never rely on command failure
 * as the non-Linux fallback path.
 *
 * NOTE: Docker Desktop for Linux runs its own VM and manages its own
 * daemon.json. This check targets native Docker Engine installs, which
 * is what ships on DGX Spark and WSL2.
 */
function isCgroupV2() {
  if (process.platform !== "linux") return false;
  const fstype = runCapture("stat -fc %T /sys/fs/cgroup 2>/dev/null", { ignoreError: true });
  return fstype === "cgroup2fs";
}

/**
 * Read and parse /etc/docker/daemon.json.
 *
 * Returns the parsed object, or null if the file doesn't exist or isn't
 * valid JSON.
 */
function readDaemonJson(daemonPath) {
  const p = daemonPath || DEFAULT_DAEMON_JSON;
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Check whether Docker is configured for cgroupns=host.
 *
 * On cgroup v2 systems, OpenShell's gateway starts k3s inside a Docker
 * container. k3s needs the host cgroup namespace to manage cgroup
 * hierarchies. Without "default-cgroupns-mode": "host" in daemon.json,
 * kubelet fails with:
 *
 *   openat2 /sys/fs/cgroup/kubepods/pids.max: no such file or directory
 *
 * Returns an object:
 *   { ok: true }                     -- no issue (cgroup v1, or already configured)
 *   { ok: false, reason: string }    -- needs fix
 */
function checkCgroupConfig(opts) {
  const cgroupV2 = opts && typeof opts.cgroupV2 === "boolean" ? opts.cgroupV2 : isCgroupV2();
  if (!cgroupV2) {
    return { ok: true };
  }

  const daemonPath = (opts && opts.daemonPath) || DEFAULT_DAEMON_JSON;
  const config = readDaemonJson(daemonPath);

  if (config && config["default-cgroupns-mode"] === "host") {
    return { ok: true };
  }

  return {
    ok: false,
    reason: config
      ? `${daemonPath} exists but "default-cgroupns-mode" is not set to "host"`
      : `${daemonPath} does not exist or is not valid JSON`,
  };
}

module.exports = { isCgroupV2, readDaemonJson, checkCgroupConfig };
