// @ts-nocheck
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

/**
 * Run a command, streaming stdout/stderr (redacted) to the terminal.
 * Exits the process on failure unless opts.ignoreError is true.
 *
 * Accepts two forms:
 *   run("bash -c string")  — legacy: passes the string to bash for interpretation
 *   run(["docker", "rm", name])  — safe: calls spawnSync(exe, args) with no shell
 *
 * When an argv array is passed, the shell option is forbidden to prevent
 * callers from accidentally re-enabling shell interpretation.
 */
function run(cmd, opts = {}) {
  if (Array.isArray(cmd)) {
    return runArrayCmd(cmd, opts);
  }
  const stdio = opts.stdio ?? ["ignore", "pipe", "pipe"];
  const result = spawnSync("bash", ["-c", cmd], {
    ...opts,
    stdio,
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
  });
  if (!opts.suppressOutput) {
    writeRedactedResult(result, stdio);
  }
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(`  Command failed (exit ${result.status}): ${redact(cmd).slice(0, 80)}`);
    process.exit(result.status || 1);
  }
  return result;
}

/**
 * Internal: execute an argv array via spawnSync with no shell.
 * Shared by run() and kept separate for clarity.
 */
function runArrayCmd(cmd, opts = {}) {
  if (cmd.length === 0) {
    throw new Error("run: argv array must not be empty");
  }

  const exe = cmd[0];
  const args = cmd.slice(1);
  const { ignoreError, suppressOutput, env: extraEnv, stdio: stdioCfg, ...spawnOpts } = opts;

  // Guard: re-enabling shell interpretation defeats the purpose of argv arrays.
  if (spawnOpts.shell) {
    throw new Error("run: shell option is forbidden when passing an argv array");
  }

  const stdio = stdioCfg ?? ["ignore", "pipe", "pipe"];

  const result = spawnSync(exe, args, {
    ...spawnOpts,
    stdio,
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
  });
  if (!suppressOutput) {
    writeRedactedResult(result, stdio);
  }
  // Check result.error first — spawnSync sets this (with status === null) when
  // the executable is missing (ENOENT), the call times out, or the spawn fails.
  if (result.error && !ignoreError) {
    const cmdStr = cmd.join(" ");
    console.error(`  Command failed: ${redact(cmdStr).slice(0, 80)}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0 && !ignoreError) {
    const cmdStr = cmd.join(" ");
    console.error(`  Command failed (exit ${result.status}): ${redact(cmdStr).slice(0, 80)}`);
    process.exit(result.status || 1);
  }
  return result;
}

/**
 * Run a shell command interactively (stdin inherited) while capturing and redacting stdout/stderr.
 * Exits the process on failure unless opts.ignoreError is true.
 */
function runInteractive(cmd, opts = {}) {
  const stdio = opts.stdio ?? ["inherit", "pipe", "pipe"];
  const result = spawnSync("bash", ["-c", cmd], {
    ...opts,
    stdio,
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
  });
  if (!opts.suppressOutput) {
    writeRedactedResult(result, stdio);
  }
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(`  Command failed (exit ${result.status}): ${redact(cmd).slice(0, 80)}`);
    process.exit(result.status || 1);
  }
  return result;
}

/**
 * Run a command and return its stdout as a trimmed string.
 * Throws a redacted error on failure, or returns '' when opts.ignoreError is true.
 *
 * Accepts two forms:
 *   runCapture("some shell command")  — legacy: passes the string to execSync (shell)
 *   runCapture(["curl", "-sf", url])  — safe: calls spawnSync(exe, args) with no shell
 *
 * When an argv array is passed, the shell option is forbidden to prevent
 * callers from accidentally re-enabling shell interpretation.
 */
function runCapture(cmd, opts = {}) {
  if (Array.isArray(cmd)) {
    return runArrayCapture(cmd, opts);
  }
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
    throw redactError(err);
  }
}

/**
 * Internal: capture stdout from an argv array via spawnSync with no shell.
 * Shared by runCapture() and kept separate for clarity.
 */
function runArrayCapture(cmd, opts = {}) {
  if (cmd.length === 0) {
    throw new Error("runCapture: argv array must not be empty");
  }

  const exe = cmd[0];
  const args = cmd.slice(1);
  const { ignoreError, env: extraEnv, stdio: _stdio, encoding: _encoding, ...spawnOpts } = opts;

  // Guard: re-enabling shell interpretation defeats the purpose of argv arrays.
  if (spawnOpts.shell) {
    throw new Error("runCapture: shell option is forbidden when passing an argv array");
  }

  try {
    const result = spawnSync(exe, args, {
      ...spawnOpts,
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });

    // Check result.error first — spawnSync sets this (with status === null) when
    // the executable is missing (ENOENT), the call times out, or the spawn fails.
    if (result.error) {
      if (ignoreError) return "";
      throw result.error;
    }
    if (result.status !== 0) {
      if (ignoreError) return "";
      throw new Error(`Command failed with status ${result.status}`);
    }

    const stdout = result.stdout || "";
    return (typeof stdout === "string" ? stdout : stdout.toString("utf-8")).trim();
  } catch (err) {
    if (ignoreError) return "";
    throw redactError(err);
  }
}

/**
 * Redact known secret patterns from a string to prevent accidental leaks
 * in CLI log and error output. Covers NVIDIA API keys, bearer tokens,
 * generic API key assignments, and base64-style long tokens.
 */
// Single source of truth for secret patterns — see secret-patterns.ts
const { SECRET_PATTERNS } = require("./secret-patterns");

/**
 * Partially redact a matched secret string: keep the first 4 chars and replace
 * the rest with asterisks (capped at 20 asterisks).
 */
function redactMatch(match) {
  return match.slice(0, 4) + "*".repeat(Math.min(match.length - 4, 20));
}

/**
 * Redact credentials from a URL string: clears url.password and blanks
 * known auth-style query params (auth, sig, signature, token, access_token).
 * Returns the original value unchanged if it cannot be parsed as a URL.
 */
function redactUrl(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  try {
    const url = new URL(value);
    if (url.password) {
      url.password = "****";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/(^|[-_])(?:signature|sig|token|auth|access_token)$/i.test(key)) {
        url.searchParams.set(key, "****");
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * Redact known secret patterns and authenticated URLs from a string.
 * Non-string values are returned unchanged.
 */
function redact(str) {
  if (typeof str !== "string") return str;
  let out = str.replace(/https?:\/\/[^\s'"]+/g, redactUrl);
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, redactMatch);
  }
  return out;
}

/**
 * Redact sensitive fields on an error object before surfacing it to callers.
 * NOTE: this mutates the original error instance in place.
 */
function redactError(err) {
  if (!err || typeof err !== "object") return err;
  const originalMessage = typeof err.message === "string" ? err.message : null;
  if (typeof err.message === "string") err.message = redact(err.message);
  if (typeof err.cmd === "string") err.cmd = redact(err.cmd);
  if (typeof err.stdout === "string") err.stdout = redact(err.stdout);
  if (typeof err.stderr === "string") err.stderr = redact(err.stderr);
  if (Array.isArray(err.output)) {
    err.output = err.output.map((value) => (typeof value === "string" ? redact(value) : value));
  }
  if (originalMessage && typeof err.stack === "string") {
    err.stack = err.stack.replaceAll(originalMessage, err.message);
  }
  return err;
}

/**
 * Write redacted stdout/stderr from a spawnSync result to the parent process streams.
 * No-op when stdio is 'inherit' or not an array.
 */
function writeRedactedResult(result, stdio) {
  if (!result || stdio === "inherit" || !Array.isArray(stdio)) return;
  if (stdio[1] === "pipe" && result.stdout) {
    process.stdout.write(redact(result.stdout.toString()));
  }
  if (stdio[2] === "pipe" && result.stderr) {
    process.stderr.write(redact(result.stderr.toString()));
  }
}

/**
 * Shell-quote a value for safe interpolation into bash -c strings.
 * Wraps in single quotes and escapes embedded single quotes.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Validate a name (sandbox, instance, container) against RFC 1123 label rules.
 * Rejects shell metacharacters, path traversal, and empty/overlength names.
 */
function validateName(name, label = "name") {
  if (!name || typeof name !== "string") {
    throw new Error(`${label} is required`);
  }
  if (name.length > 63) {
    throw new Error(`${label} too long (max 63 chars): '${name.slice(0, 20)}...'`);
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new Error(
      `Invalid ${label}: '${name}'. Must be lowercase alphanumeric with optional internal hyphens.`,
    );
  }
  return name;
}

export {
  ROOT,
  SCRIPTS,
  redact,
  run,
  runCapture,
  runInteractive,
  shellQuote,
  validateName,
};
