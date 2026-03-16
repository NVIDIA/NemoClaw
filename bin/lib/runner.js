// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");
const COLIMA_PROFILE = process.env.COLIMA_PROFILE || "default";
const COLIMA_SOCKET = path.join(process.env.HOME || "/tmp", `.colima/${COLIMA_PROFILE}/docker.sock`);

// Auto-detect Colima Docker socket
if (!process.env.DOCKER_HOST) {
  if (fs.existsSync(COLIMA_SOCKET)) {
    process.env.DOCKER_HOST = `unix://${COLIMA_SOCKET}`;
  }
}

function run(cmd, opts = {}) {
  const result = spawnSync("bash", ["-o", "pipefail", "-c", cmd], {
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

module.exports = { ROOT, SCRIPTS, COLIMA_PROFILE, COLIMA_SOCKET, run, runCapture };
