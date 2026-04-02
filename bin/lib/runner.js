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
 * Run a shell command via bash, streaming stdout/stderr (redacted) to the terminal.
 * Exits the process on failure unless opts.ignoreError is true.
 */
function run(cmd, opts = {}) {
  const stdio = opts.stdio ?? ["ignore", "pipe", "pipe"];
  const result = spawnSync("bash", ["-c", cmd], {
    ...opts,
    stdio,
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
  });
  writeRedactedResult(result, stdio);
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(`  Command failed (exit ${result.status}): ${redact(cmd).slice(0, 80)}`);
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
  writeRedactedResult(result, stdio);
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(`  Command failed (exit ${result.status}): ${redact(cmd).slice(0, 80)}`);
    process.exit(result.status || 1);
  }
  return result;
}

/**
 * Run a shell command and return its stdout as a trimmed string.
 * Throws a redacted error on failure, or returns '' when opts.ignoreError is true.
 */
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
    throw redactError(err);
  }
}

/**
 * Redact known secret patterns from a string to prevent accidental leaks
 * in CLI log and error output. Covers NVIDIA API keys, bearer tokens,
 * generic API key assignments, and base64-style long tokens.
 */
const SECRET_PATTERNS = [
  /nvapi-[A-Za-z0-9_-]{10,}/g,
  /nvcf-[A-Za-z0-9_-]{10,}/g,
  /ghp_[A-Za-z0-9_-]{10,}/g,
  /(?<=Bearer\s+)[A-Za-z0-9_.+/=-]{10,}/gi,
  /(?<=(?:_KEY|API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[=: ]['"]?)[A-Za-z0-9_.+/=-]{10,}/gi,
];

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

module.exports = {
  ROOT,
  SCRIPTS,
  redact,
  run,
  runCapture,
  runInteractive,
  shellQuote,
  validateName,
};
