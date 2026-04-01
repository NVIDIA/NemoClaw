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
    console.error(`  Command failed (exit ${result.status}): ${redact(cmd).slice(0, 80)}`);
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
    console.error(`  Command failed (exit ${result.status}): ${redact(cmd).slice(0, 80)}`);
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

function redact(str) {
  if (typeof str !== "string") return str;
  let out = str;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, (match) => match.slice(0, 4) + "*".repeat(Math.min(match.length - 4, 20)));
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

module.exports = { ROOT, SCRIPTS, redact, run, runCapture, runInteractive, shellQuote, validateName };
