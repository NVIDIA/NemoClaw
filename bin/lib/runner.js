// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const { detectDockerHost } = require("./platform");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");

const dockerHost = detectDockerHost();
if (dockerHost) {
  process.env.DOCKER_HOST = dockerHost.dockerHost;
}

function run(cmd, opts = {}) {
  const stdio = opts.stdio ?? ["ignore", "inherit", "inherit"];
  const result = spawnSync("bash", ["-c", cmd], {
    ...opts,
    stdio,
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(`  Command failed (exit ${result.status}): ${cmd.slice(0, 80)}`);
    process.exit(result.status || 1);
  }
  return result;
}

function runInteractive(cmd, opts = {}) {
  const stdio = opts.stdio ?? "inherit";
  const result = spawnSync("bash", ["-c", cmd], {
    ...opts,
    stdio,
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
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
      ...opts,
      encoding: "utf-8",
      cwd: ROOT,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    if (opts.ignoreError) return "";
    throw err;
  }
}

/**
 * Validate a sandbox or instance name to prevent shell injection.
 * Names must be 1–63 chars, alphanumeric with dots, hyphens, and underscores,
 * and must start with a letter or digit.
 */
function validateName(name) {
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name)) {
    console.error(`  Invalid name: '${String(name).slice(0, 40)}'`);
    console.error("  Names must be 1–63 characters: letters, digits, hyphens, underscores, dots.");
    process.exit(1);
  }
}

module.exports = { ROOT, SCRIPTS, run, runCapture, runInteractive, validateName };
