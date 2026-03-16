// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");

// Auto-detect Colima Docker socket
if (!process.env.DOCKER_HOST) {
  const colimaSocket = path.join(process.env.HOME || "/tmp", ".colima/default/docker.sock");
  if (fs.existsSync(colimaSocket)) {
    process.env.DOCKER_HOST = `unix://${colimaSocket}`;
  }
}

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

/**
 * Validate a sandbox or instance name to prevent shell injection.
 * Names must be 1–63 chars, alphanumeric with hyphens and underscores,
 * and must start with a letter or digit.
 */
function validateName(name) {
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name)) {
    console.error(`  Invalid name: '${String(name).slice(0, 40)}'`);
    console.error("  Names must be 1–63 characters: letters, digits, hyphens, underscores, dots.");
    process.exit(1);
  }
}

module.exports = { ROOT, SCRIPTS, run, runCapture, validateName };
