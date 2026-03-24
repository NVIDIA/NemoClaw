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

// Redact known secret patterns from command strings for logging and error output.
// Handles unquoted (KEY=val), double-quoted (KEY="val"), and single-quoted (KEY='val') forms.
function redactSecrets(str) {
  const keyedSecrets = [
    "NVIDIA_API_KEY",
    "GITHUB_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "OPENAI_API_KEY",
    "SLACK_BOT_TOKEN",
    "DISCORD_BOT_TOKEN",
  ];
  let result = String(str ?? "");
  for (const key of keyedSecrets) {
    // Match KEY="quoted" or KEY='quoted' or KEY=unquoted
    const pattern = new RegExp(`${key}=(?:"[^"]*"|'[^']*'|[^\\s"']*)`, "g");
    result = result.replace(pattern, `${key}=***`);
  }
  // Bare nvapi- tokens (e.g., in Bearer headers)
  result = result.replace(/nvapi-[A-Za-z0-9_-]+/g, (match) => match.slice(0, 8) + "***");
  return result;
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
    console.error(`  Command failed (exit ${result.status}): ${redactSecrets(cmd.slice(0, 80))}`);
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
    console.error(`  Command failed (exit ${result.status}): ${redactSecrets(cmd.slice(0, 80))}`);
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
    // Redact secrets from the error message so callers that log the
    // thrown error don't accidentally leak credentials.
    if (err.message) {
      err.message = redactSecrets(err.message);
    }
    if (err.stderr) {
      err.stderr = redactSecrets(err.stderr);
    }
    if (err.stdout) {
      err.stdout = redactSecrets(err.stdout);
    }
    throw err;
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
      `Invalid ${label}: '${name}'. Must be lowercase alphanumeric with optional internal hyphens.`
    );
  }
  return name;
}

module.exports = { ROOT, SCRIPTS, run, runCapture, runInteractive, shellQuote, validateName, redactSecrets };
