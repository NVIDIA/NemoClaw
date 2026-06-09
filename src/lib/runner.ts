// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  SpawnSyncOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";
import { NAME_ALLOWED_FORMAT, NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "./name-validation";

const { spawnSync } = require("child_process");
const path = require("path");
const { detectDockerHost } = require("./platform");
const { shellQuote } = require("./core/shell-quote") as typeof import("./core/shell-quote");
const { buildSubprocessEnv } = require("./subprocess-env") as typeof import("./subprocess-env");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");

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

function buildRunnerEnv(extraEnv?: NodeJS.ProcessEnv): Record<string, string> {
  const normalizedExtra: Record<string, string> = {};
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value !== undefined) normalizedExtra[key] = value;
    }
  }
  return buildSubprocessEnv(normalizedExtra);
}

function rejectNulByte(value: string, label: string): string {
  if (value.includes("\0")) {
    throw new Error(`${label} must not contain NUL bytes`);
  }
  return value;
}

function normalizeSpawnFile(file: string, callerName: string): string {
  const normalized = rejectNulByte(String(file), `${callerName}: executable`);
  if (normalized.length === 0) {
    throw new Error(`${callerName}: executable must not be empty`);
  }
  return normalized;
}

function normalizeSpawnArgs(args: readonly unknown[], callerName: string): string[] {
  return args.map((arg, index) => rejectNulByte(String(arg), `${callerName}: argv[${index + 1}]`));
}

function normalizeArgv(cmd: readonly string[], callerName: string): [string, string[]] {
  if (cmd.length === 0) {
    throw new Error(`${callerName}: argv array must not be empty`);
  }
  const [file, ...args] = cmd;
  return [normalizeSpawnFile(file, callerName), normalizeSpawnArgs(args, callerName)];
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
  const safeFile = normalizeSpawnFile(file, "spawnAndHandle");
  const safeArgs = normalizeSpawnArgs(args, "spawnAndHandle");
  // All non-shell runner paths pass argv arrays and force shell=false; runShell
  // and runInteractiveShell enter here with a literal `bash -c` executable and
  // an explicitly named shell boundary. Extra environment values are filtered by
  // buildRunnerEnv before spawn.
  // lgtm[js/indirect-command-line-injection]
  // lgtm[js/shell-command-injection-from-environment]
  const result = spawnSync(safeFile, safeArgs, {
    ...opts,
    shell: false,
    stdio,
    cwd: ROOT,
    env: buildRunnerEnv(opts.env),
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
    logOpenshellRuntimeHint(safeFile, renderedCommand);
    process.exit(result.status || 1);
  }
  return result;
}

/**
 * Run a program directly with argv-style arguments, bypassing shell parsing.
 * Exits the process on failure unless opts.ignoreError is true.
 *
 * Shell-string execution is intentionally unsupported here. If a caller truly
 * needs shell parsing, it must opt in explicitly via runShell().
 */
function run(cmd: readonly string[], opts: RunnerOptions = {}): SpawnResult {
  if (!Array.isArray(cmd)) {
    throw new Error("run no longer accepts shell strings; pass an argv array instead");
  }
  return runArrayCmd(cmd, opts);
}

/**
 * Run an explicit shell command string through bash -c.
 * Exits the process on failure unless opts.ignoreError is true.
 */
function runShell(cmd: string, opts: RunnerOptions = {}): SpawnResult {
  const shellCmd = String(cmd);
  const stdio = opts.stdio ?? ["ignore", "pipe", "pipe"];
  return spawnAndHandle("bash", ["-c", shellCmd], opts, stdio, shellCmd);
}

/**
 * Internal: execute an argv array via spawnSync with no shell.
 * Shared by run() and runInteractive() and kept separate for clarity.
 */
function runArrayCmd(
  cmd: readonly string[],
  opts: RunnerOptions = {},
  defaultStdio: RunnerOptions["stdio"] = ["ignore", "pipe", "pipe"],
  callerName = "run",
): SpawnResult {
  const [exe, args] = normalizeArgv(cmd, callerName);
  const { ignoreError, suppressOutput, env: extraEnv, stdio: stdioCfg, ...spawnOpts } = opts;

  // Guard: re-enabling shell interpretation defeats the purpose of argv arrays.
  if (spawnOpts.shell) {
    throw new Error(`${callerName}: shell option is forbidden when passing an argv array`);
  }

  const stdio = stdioCfg ?? defaultStdio;

  // run() always uses argv arrays, rejects `shell: true` above, and validates
  // the executable/argv for process-spawn metacharacters such as NUL bytes.
  // lgtm[js/indirect-command-line-injection]
  // lgtm[js/shell-command-injection-from-environment]
  const result = spawnSync(exe, args, {
    ...spawnOpts,
    shell: false,
    stdio,
    cwd: ROOT,
    env: buildRunnerEnv(extraEnv),
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
 * Run a program directly with argv-style arguments while inheriting stdin.
 * Exits the process on failure unless opts.ignoreError is true.
 */
function runInteractive(cmd: readonly string[], opts: RunnerOptions = {}): SpawnResult {
  if (!Array.isArray(cmd)) {
    throw new Error("runInteractive no longer accepts shell strings; pass an argv array instead");
  }
  return runArrayCmd(cmd, opts, ["inherit", "pipe", "pipe"], "runInteractive");
}

/**
 * Run an explicit shell command string interactively (stdin inherited).
 * Exits the process on failure unless opts.ignoreError is true.
 */
function runInteractiveShell(cmd: string, opts: RunnerOptions = {}): SpawnResult {
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
  const [exe, args] = normalizeArgv(cmd, "runCapture");
  const { ignoreError, env: extraEnv, stdio: _stdio, ...spawnOpts } = opts;

  // Guard: re-enabling shell interpretation defeats the purpose of argv arrays.
  if (spawnOpts.shell) {
    throw new Error("runCapture: shell option is forbidden when passing an argv array");
  }

  try {
    // runCapture() always uses argv arrays, rejects `shell: true` above, and
    // validates the executable/argv for process-spawn metacharacters such as
    // NUL bytes.
    // lgtm[js/indirect-command-line-injection]
    // lgtm[js/shell-command-injection-from-environment]
    const result = spawnSync(exe, args, {
      ...spawnOpts,
      shell: false,
      cwd: ROOT,
      env: buildRunnerEnv(extraEnv),
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
const { redact, redactError, writeRedactedResult } = require("./security/redact");

/** Structured result returned by runCaptureEx. */
export interface CaptureResult {
  stdout: string;
  /** Captured stderr, trimmed. Many tools (docker, CUDA samples) write their
   * actionable failure text here, so callers building diagnostics need it.
   * Optional so existing `runCaptureEx` test seams stay source-compatible. */
  stderr?: string;
  exitCode: number | null;
  /** True when spawnSync sets result.error due to a timeout (ETIMEDOUT). */
  timedOut: boolean;
}

/**
 * Like runCapture but returns a structured result instead of throwing or
 * collapsing errors to an empty string.  Use this when the caller needs to
 * distinguish a real timeout (curl exit 28 / spawn ETIMEDOUT) from other
 * failures such as connection-refused.
 */
function runCaptureEx(
  cmd: readonly string[],
  opts: Omit<CaptureOptions, "ignoreError"> = {},
): CaptureResult {
  if (!Array.isArray(cmd) || cmd.length === 0) {
    throw new Error("runCaptureEx: cmd must be a non-empty argv array");
  }
  const [exe, args] = normalizeArgv(cmd, "runCaptureEx");
  const { env: extraEnv, stdio: _stdio, ...spawnOpts } = opts as CaptureOptions;
  try {
    // runCaptureEx() follows the same argv-only, shell=false boundary as
    // runCapture(), while returning structured timeout diagnostics.
    // lgtm[js/indirect-command-line-injection]
    // lgtm[js/shell-command-injection-from-environment]
    const result = spawnSync(exe, args, {
      ...spawnOpts,
      shell: false,
      cwd: ROOT,
      // #2616: route via buildRunnerEnv so subprocess env is sanitized and
      // NO_PROXY=localhost,127.0.0.1 is injected when HTTP_PROXY is set.
      // Otherwise curl probes against localhost (Ollama validation, etc.)
      // tunnel through the user's host proxy and fail with HTTP 500.
      env: buildRunnerEnv(extraEnv),
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    const timedOut =
      (result.error != null && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") ||
      result.status === 28;
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    return {
      stdout: (typeof stdout === "string" ? stdout : stdout.toString("utf-8")).trim(),
      stderr: (typeof stderr === "string" ? stderr : stderr.toString("utf-8")).trim(),
      exitCode: result.status,
      timedOut,
    };
  } catch (err) {
    throw redactError(err);
  }
}

/**
 * Validate a name (sandbox, instance, container) against RFC 1123 label rules.
 * Rejects shell metacharacters, path traversal, and empty/overlength names.
 */
function validateName(name: string, label = "name"): string {
  if (!name || typeof name !== "string") {
    throw new Error(`${label} is required. Allowed format: ${NAME_ALLOWED_FORMAT}.`);
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw new Error(
      `${label} too long (max ${NAME_MAX_LENGTH} chars): '${name.slice(0, 20)}...'. Allowed format: ${NAME_ALLOWED_FORMAT}.`,
    );
  }
  if (!NAME_VALID_PATTERN.test(name)) {
    throw new Error(`Invalid ${label}: '${name}'. Allowed format: ${NAME_ALLOWED_FORMAT}.`);
  }
  return name;
}

export {
  ROOT,
  redact,
  run,
  runCapture,
  runCaptureEx,
  runFile,
  runInteractive,
  runInteractiveShell,
  runShell,
  SCRIPTS,
  shellQuote,
  validateName,
};
