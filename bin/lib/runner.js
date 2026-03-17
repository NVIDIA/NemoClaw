// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execFileSync, execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");

// Strict pattern for sandbox / instance / container names.
// Only alphanumerics, hyphens, and underscores are allowed.
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

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

/**
 * Validate that a name is safe for use as a CLI argument.
 * Throws if the name contains shell metacharacters or path separators.
 */
function assertSafeName(name, label = "name") {
  if (!name || !SAFE_NAME_RE.test(name)) {
    console.error(`  Invalid ${label}: "${name}". Only alphanumerics, hyphens, and underscores are allowed.`);
    process.exit(1);
  }
}

/**
 * Run a shell command string via bash -c.
 *
 * SECURITY: Only use this for commands built entirely from hardcoded strings.
 * Never interpolate user-controlled values into `cmd`. For commands with
 * user-controlled arguments, use runArgv() instead.
 */
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

/**
 * Run a command as an argv array — no shell interpolation.
 *
 * This is the safe alternative to run() when any argument is user-controlled.
 */
function runArgv(prog, args, opts = {}) {
  const result = spawnSync(prog, args, {
    stdio: "inherit",
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    ...opts,
  });
  if (result.status !== 0 && !opts.ignoreError) {
    const cmdPreview = [prog, ...args].join(" ").slice(0, 80);
    console.error(`  Command failed (exit ${result.status}): ${cmdPreview}`);
    process.exit(result.status || 1);
  }
  return result;
}

/**
 * Run a shell command string and capture stdout.
 *
 * SECURITY: Only use this for commands built entirely from hardcoded strings.
 * For commands with user-controlled arguments, use runCaptureArgv() instead.
 */
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
 * Run a command as an argv array and capture stdout — no shell interpolation.
 *
 * This is the safe alternative to runCapture() when any argument is user-controlled.
 */
function runCaptureArgv(prog, args, opts = {}) {
  try {
    return execFileSync(prog, args, {
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

module.exports = { ROOT, SCRIPTS, run, runArgv, runCapture, runCaptureArgv, assertSafeName };
