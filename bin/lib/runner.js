// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");

// Auto-detect Colima Docker socket (legacy ~/.colima or XDG ~/.config/colima)
if (!process.env.DOCKER_HOST) {
  const home = process.env.HOME || "/tmp";
  const candidates = [
    path.join(home, ".colima/default/docker.sock"),
    path.join(home, ".config/colima/default/docker.sock"),
  ];
  for (const sock of candidates) {
    if (fs.existsSync(sock)) {
      process.env.DOCKER_HOST = `unix://${sock}`;
      break;
    }
  }
}

function run(cmd, opts = {}) {
  const isArray = Array.isArray(cmd);
  const exe = isArray ? cmd[0] : "bash";
  const args = isArray ? cmd.slice(1) : ["-c", cmd];

  const result = spawnSync(exe, args, {
    stdio: "inherit",
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    ...opts,
  });

  if (result.status !== 0 && !opts.ignoreError) {
    const cmdStr = isArray ? cmd.join(" ") : cmd;
    console.error(`  Command failed (exit ${result.status}): ${cmdStr.slice(0, 80)}`);
    process.exit(result.status || 1);
  }
  return result;
}

function runCapture(cmd, opts = {}) {
  const isArray = Array.isArray(cmd);
  const exe = isArray ? cmd[0] : "bash";
  const args = isArray ? cmd.slice(1) : ["-c", cmd];

  try {
    const result = spawnSync(exe, args, {
      encoding: "utf-8",
      cwd: ROOT,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    });

    if (result.status !== 0 && !opts.ignoreError) {
      throw new Error(`Command failed with status ${result.status}`);
    }

    return (result.stdout || "").trim();
  } catch (err) {
    if (opts.ignoreError) return "";
    throw err;
  }
}

module.exports = { ROOT, SCRIPTS, run, runCapture };
