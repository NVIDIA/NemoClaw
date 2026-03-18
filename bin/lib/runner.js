// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execFileSync, execSync, spawnSync } = require("child_process");
const path = require("path");
const { detectDockerHost } = require("./platform");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");

// Strict allow-list for sandbox / instance / container names.
// Alphanumerics, hyphens, and underscores only; must start with alphanumeric.
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

const dockerHost = detectDockerHost();
if (dockerHost) {
  process.env.DOCKER_HOST = dockerHost.dockerHost;
}

/**
 * Validate that a name is safe for use as a CLI argument.
 * Rejects shell metacharacters, path separators, flag-prefixes, and spaces.
 * Calls process.exit(1) on failure so it can be used as a guard at CLI entry points.
 */
function assertSafeName(name, label = "name") {
  if (!name || !SAFE_NAME_RE.test(name)) {
    console.error(
      `  Invalid ${label}: "${name}". ` +
      `Only alphanumerics, hyphens, and underscores are allowed (must start with alphanumeric).`
    );
    process.exit(1);
  }
}

/**
 * Merge process.env with caller-supplied overrides without the overwrite bug.
 *
 * Bug in naive pattern:
 *   spawnSync(prog, args, { env: { ...process.env, ...opts.env }, ...opts })
 *   — the trailing `...opts` spreads opts.env over the merged result, so if
 *   the caller passes opts.env, PATH/HOME/DOCKER_HOST are silently dropped.
 *
 * Fix: extract env from opts before the final spread.
 */
function mergeEnv(opts) {
  const { env: extraEnv, ...rest } = opts;
  return {
    env: { ...process.env, ...extraEnv },
    ...rest,
  };
}

/**
 * Run a shell command string via bash -c.
 *
 * SECURITY: Only use this for commands built entirely from hardcoded strings.
 * Never interpolate user-controlled values into `cmd`.
 * For commands with any user-controlled argument, use runArgv() instead.
 */
function run(cmd, opts = {}) {
  const stdio = opts.stdio ?? ["ignore", "inherit", "inherit"];
  const result = spawnSync("bash", ["-c", cmd], {
    stdio,
    cwd: ROOT,
    ...mergeEnv(opts),
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
    stdio,
    cwd: ROOT,
    ...mergeEnv(opts),
  });
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(`  Command failed (exit ${result.status}): ${cmd.slice(0, 80)}`);
    process.exit(result.status || 1);
  }
  return result;
}

/**
 * Run a command as an argv array — no shell, no interpolation.
 *
 * This is the safe alternative to run() for any command with user-controlled
 * arguments. spawnSync(prog, args) bypasses the shell entirely, so metacharacters
 * like ; | $() ` && are passed as literal strings to the program.
 */
function runArgv(prog, args, opts = {}) {
  const result = spawnSync(prog, args, {
    stdio: "inherit",
    cwd: ROOT,
    ...mergeEnv(opts),
  });
  if (result.status !== 0 && !opts.ignoreError) {
    const preview = [prog, ...args].join(" ").slice(0, 80);
    console.error(`  Command failed (exit ${result.status}): ${preview}`);
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
      stdio: ["pipe", "pipe", "pipe"],
      ...mergeEnv(opts),
    }).trim();
  } catch (err) {
    if (opts.ignoreError) return "";
    throw err;
  }
}

/**
 * Run a command as an argv array and capture stdout — no shell, no interpolation.
 *
 * This is the safe alternative to runCapture() for any command with user-controlled
 * arguments. execFileSync(prog, args) bypasses the shell entirely.
 */
function runCaptureArgv(prog, args, opts = {}) {
  try {
    return execFileSync(prog, args, {
      encoding: "utf-8",
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      ...mergeEnv(opts),
    }).trim();
  } catch (err) {
    if (opts.ignoreError) return "";
    throw err;
  }
}

module.exports = { ROOT, SCRIPTS, run, runArgv, runCapture, runCaptureArgv, runInteractive, assertSafeName };
