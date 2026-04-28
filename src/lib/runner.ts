// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  SpawnSyncOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";

const { spawnSync } = require("child_process");
const path = require("path");
const { detectDockerHost } = require("./platform");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");

type RunnerScalar = string | number | boolean | null | undefined;

type RunnerOptions = SpawnSyncOptions & {
  ignoreError?: boolean;
  suppressOutput?: boolean;
};

type CaptureOptions = Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> & {
  ignoreError?: boolean;
};

type SpawnResult = SpawnSyncReturns<string | Buffer>;

const dockerHost = detectDockerHost();
if (dockerHost) {
  process.env.DOCKER_HOST = dockerHost.dockerHost;
}

function logOpenshellRuntimeHint(file: string, renderedCommand = ""): void {
  if (
    file === "openshell" ||
    file?.endsWith("/openshell") ||
    (file === "bash" && /^\s*openshell\s/.test(renderedCommand))
  ) {
    console.error("  This error originated from the OpenShell runtime layer.");
    console.error("  Docs: https://github.com/NVIDIA/OpenShell");
  }
}

/**
 * Spawn a command, streaming stdout/stderr (redacted) to the terminal.
 * Exits the process on failure unless opts.ignoreError is true.
 */
function spawnAndHandle(
  file: string,
  args: readonly string[],
  opts: RunnerOptions = {},
  stdio: RunnerOptions["stdio"],
  renderedCommand: string,
): SpawnResult {
  const result = spawnSync(file, args, {
    ...opts,
    stdio,
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
  });
  if (!opts.suppressOutput) {
    writeRedactedResult(result, stdio);
  }
  if (result.error && !opts.ignoreError) {
    console.error(
      `  Command failed: ${redact(renderedCommand).slice(0, 80)}: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(
      `  Command failed (exit ${result.status}): ${redact(renderedCommand).slice(0, 80)}`,
    );
    logOpenshellRuntimeHint(file, renderedCommand);
    process.exit(result.status || 1);
  }
  return result;
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
function run(cmd: string | readonly string[], opts: RunnerOptions = {}): SpawnResult {
  if (Array.isArray(cmd)) {
    return runArrayCmd(cmd, opts);
  }
  const shellCmd = String(cmd);
  const stdio = opts.stdio ?? ["ignore", "pipe", "pipe"];
  return spawnAndHandle("bash", ["-c", shellCmd], opts, stdio, shellCmd);
}

/**
 * Internal: execute an argv array via spawnSync with no shell.
 * Shared by run() and kept separate for clarity.
 */
function runArrayCmd(cmd: readonly string[], opts: RunnerOptions = {}): SpawnResult {
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
    logOpenshellRuntimeHint(exe);
    process.exit(result.status || 1);
  }
  return result;
}

/**
 * Run a shell command interactively (stdin inherited) while capturing and redacting stdout/stderr.
 * Exits the process on failure unless opts.ignoreError is true.
 */
function runInteractive(cmd: string, opts: RunnerOptions = {}): SpawnResult {
  const stdio = opts.stdio ?? ["inherit", "pipe", "pipe"];
  return spawnAndHandle("bash", ["-c", cmd], opts, stdio, cmd);
}

/**
 * Run a program directly with argv-style arguments, bypassing shell parsing.
 * Exits the process on failure unless opts.ignoreError is true.
 */
function runFile(
  file: string,
  args: readonly (string | number | boolean)[] = [],
  opts: RunnerOptions = {},
): SpawnResult {
  if (opts.shell) {
    throw new Error("runFile does not allow opts.shell=true");
  }
  const stdio = opts.stdio ?? ["ignore", "pipe", "pipe"];
  const normalizedArgs = args.map((arg) => String(arg));
  const rendered = [shellQuote(file), ...normalizedArgs.map((arg) => shellQuote(arg))].join(" ");
  return spawnAndHandle(file, normalizedArgs, { ...opts, shell: false }, stdio, rendered);
}

/**
 * Run a program directly with argv-style arguments and capture trimmed stdout.
 * Throws a redacted error on failure, or returns '' when opts.ignoreError is true.
 *
 * Shell-string capture is intentionally unsupported. If you truly need shell
 * parsing, spell it out explicitly at the call site (for example
 * ["sh", "-c", script]) so reviews and static checks can see the boundary.
 */
function runCapture(cmd: readonly string[], opts: CaptureOptions = {}): string {
  if (!Array.isArray(cmd)) {
    throw new Error("runCapture no longer accepts shell strings; pass an argv array instead");
  }
  if (cmd.length === 0) {
    throw new Error("runCapture: argv array must not be empty");
  }

  const exe = cmd[0];
  const args = cmd.slice(1);
  const { ignoreError, env: extraEnv, stdio: _stdio, ...spawnOpts } = opts;

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

// Unified redaction — see redact.ts (#2381).
const { redact, redactError, writeRedactedResult } = require("./redact");

/**
 * Shell-quote a value for safe interpolation into bash -c strings.
 * Wraps in single quotes and escapes embedded single quotes.
 */
function shellQuote(value: RunnerScalar): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Validate a name (sandbox, instance, container) against RFC 1123 label rules.
 * Rejects shell metacharacters, path traversal, and empty/overlength names.
 */
function validateName(name: string, label = "name"): string {
  if (!name || typeof name !== "string") {
    throw new Error(`${label} is required`);
  }
  if (name.length > 63) {
    throw new Error(`${label} too long (max 63 chars): '${name.slice(0, 20)}...'`);
  }
  if (!/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new Error(
      `Invalid ${label}: '${name}'. Must start with a letter and contain only lowercase alphanumerics with optional internal hyphens.`,
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
  runFile,
  runInteractive,
  shellQuote,
  validateName,
};
