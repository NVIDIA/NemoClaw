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

// Env vars that must never be overridden by callers — they enable code
// execution, library injection, or trust-store hijacking in subprocesses.
const BLOCKED_ENV_VARS = new Set([
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
  "NODE_OPTIONS", "BASH_ENV", "ENV",
  "GIT_SSH_COMMAND", "SSH_AUTH_SOCK",
  "DOCKER_HOST", "KUBECONFIG",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
  "CURL_CA_BUNDLE", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
]);

function sanitizeEnv(callerEnv) {
  if (!callerEnv) return {};
  const clean = {};
  for (const [k, v] of Object.entries(callerEnv)) {
    if (!BLOCKED_ENV_VARS.has(k)) clean[k] = v;
  }
  return clean;
}

/**
 * Shell-free alternative to run(). Executes prog with an argv array via
 * spawnSync(prog, args) — no bash, no string interpolation, no injection.
 * Use this for any command that includes user-controlled values.
 */
function runArgv(prog, args, opts = {}) {
  const { env, ...spawnOpts } = opts;
  const result = spawnSync(prog, args, {
    stdio: "inherit",
    ...spawnOpts,
    cwd: ROOT,
    env: { ...process.env, ...sanitizeEnv(env) },
    shell: false,
  });
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(`  Command failed (exit ${result.status}): ${prog} ${args.join(" ").slice(0, 60)}`);
    process.exit(result.status || 1);
  }
  return result;
}

/**
 * Shell-free alternative to runCapture(). Uses execFileSync(prog, args)
 * with no shell. Returns trimmed stdout.
 */
function runCaptureArgv(prog, args, opts = {}) {
  const { env, ...execOpts } = opts;
  const { execFileSync } = require("child_process");
  try {
    return execFileSync(prog, args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      ...execOpts,
      cwd: ROOT,
      env: { ...process.env, ...sanitizeEnv(env) },
      shell: false,
    }).trim();
  } catch (err) {
    if (opts.ignoreError) return "";
    throw err;
  }
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

module.exports = { ROOT, SCRIPTS, run, runCapture, runArgv, runCaptureArgv };
