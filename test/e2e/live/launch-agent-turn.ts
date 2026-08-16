// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

export const OPENCLAW_LAUNCH_RUNTIME_ENV_SCRIPT =
  'if [ -r "/tmp/nemoclaw-proxy-env.sh" ]; then builtin source "/tmp/nemoclaw-proxy-env.sh" || exit $?; fi; builtin unset OPENCLAW_GATEWAY_TOKEN; builtin exec -- "$@"';

// This script runs inside the same PTY process that will become OpenClaw. It
// publishes fd 0 identity before execve preserves that descriptor for the
// unchanged production command.
export const OPENCLAW_PTY_RECORD_WRITER_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");

const [runId, recordRoot, ...originalArgv] = process.argv.slice(1);
const recordPath = path.join(recordRoot, "pty-record.json");
const temporaryPath = path.join(recordRoot, "pty-record.json.tmp");

function fail(reason) {
  process.stderr.write(JSON.stringify({ reason }) + "\n");
  process.exit(72);
}

function exactMode(stats, mode) {
  return (stats.mode & 0o777) === mode;
}

function validateRecordRoot() {
  let stats;
  try {
    stats = fs.lstatSync(recordRoot);
  } catch {
    fail("pty_record_root_unavailable");
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== process.getuid() ||
    !exactMode(stats, 0o700)
  ) {
    fail("pty_record_root_invalid");
  }
}

function writeRecord(record) {
  const body = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(body) > 1024) fail("pty_record_invalid");
  let fd;
  let created = false;
  try {
    fd = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, body, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryPath, recordPath);
    const directoryFd = fs.openSync(recordRoot, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    if (created) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {}
    }
    fail("pty_record_write_failed");
  }
}

if (!/^[0-9a-f]{32}$/.test(runId || "")) fail("pty_run_id_invalid");
if (recordRoot !== "/tmp/nemoclaw-launch-turn-" + runId) fail("pty_record_root_invalid");
if (originalArgv.length === 0) fail("pty_original_argv_invalid");
if (typeof process.execve !== "function") fail("pty_execve_unavailable");

try {
  fs.mkdirSync(recordRoot, { mode: 0o700 });
  fs.chmodSync(recordRoot, 0o700);
} catch {
  fail("pty_record_root_create_failed");
}
validateRecordRoot();

let ttyPath;
let ttyStats;
try {
  ttyPath = fs.realpathSync("/proc/self/fd/0");
  ttyStats = fs.fstatSync(0, { bigint: true });
} catch {
  fail("pty_stdin_unavailable");
}
if (!/^\/dev\/pts\/\d+$/.test(ttyPath)) fail("pty_stdin_not_pty");
if (!ttyStats.isCharacterDevice()) fail("pty_stdin_not_character_device");

writeRecord({
  schemaVersion: 1,
  runId,
  ttyPath,
  dev: ttyStats.dev.toString(),
  ino: ttyStats.ino.toString(),
  rdev: ttyStats.rdev.toString(),
});

process.execve("/usr/bin/env", ["/usr/bin/env", ...originalArgv], process.env);
fail("pty_execve_failed");
`;

// The host shim changes only the exact OpenClaw launch exec. Every other
// OpenShell call reaches the pinned binary with unchanged argv.
export const OPENCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT = String.raw`#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const realOpenShell = process.env.NEMOCLAW_OPENSHELL_COMMAND;
const sandboxName = process.env.NEMOCLAW_LAUNCH_SANDBOX;
const runId = process.env.NEMOCLAW_LAUNCH_RUN_ID;
const interceptPath = process.env.NEMOCLAW_LAUNCH_INTERCEPT_PATH;
const writerScript = process.env.NEMOCLAW_LAUNCH_PTY_RECORD_WRITER_SCRIPT;
const runtimeEnvScript = process.env.NEMOCLAW_LAUNCH_RUNTIME_ENV_SCRIPT;

function fail(reason) {
  process.stderr.write(JSON.stringify({ reason }) + "\n");
  process.exit(73);
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function runRealOpenShell(nextArgv) {
  const result = childProcess.spawnSync(realOpenShell, nextArgv, {
    stdio: "inherit",
    timeout: 240_000,
    killSignal: "SIGKILL",
  });
  if (result.error) fail("openshell_shim_invocation_failed");
  if (result.status === null) fail("openshell_shim_signaled");
  process.exit(result.status);
}

if (!path.isAbsolute(realOpenShell || "")) fail("openshell_shim_authority_invalid");
if (!/^[0-9a-f]{32}$/.test(runId || "")) fail("openshell_shim_run_id_invalid");
if (!path.isAbsolute(interceptPath || "")) fail("openshell_shim_intercept_path_invalid");
if (!writerScript || !runtimeEnvScript) fail("openshell_shim_script_missing");

const sameSandbox =
  argv[0] === "sandbox" &&
  argv[1] === "exec" &&
  argv[2] === "--name" &&
  argv[3] === sandboxName;
const separator = argv.indexOf("--");
const remoteArgv = separator === -1 ? [] : argv.slice(separator + 1);
const expectedTail = ["bash", "-lc", "openclaw tui"];
const hasExpectedTail = arraysEqual(remoteArgv.slice(-expectedTail.length), expectedTail);
const launchLike = sameSandbox && hasExpectedTail;

if (!launchLike) runRealOpenShell(argv);

let optionIndex = 4;
if (argv[optionIndex] === "-g") {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(argv[optionIndex + 1] || "")) {
    fail("openshell_launch_invocation_invalid");
  }
  optionIndex += 2;
}
const expectedOptions = ["--tty", "--timeout", "0", "--"];
const expectedRemote = [
  "/bin/bash",
  "--noprofile",
  "--norc",
  "-p",
  "-c",
  runtimeEnvScript,
  "nemoclaw-runtime-env",
  ...expectedTail,
];
if (
  !arraysEqual(argv.slice(optionIndex, optionIndex + expectedOptions.length), expectedOptions) ||
  optionIndex + expectedOptions.length !== separator + 1 ||
  !arraysEqual(remoteArgv, expectedRemote)
) {
  fail("openshell_launch_invocation_invalid");
}

try {
  fs.writeFileSync(interceptPath, JSON.stringify({ schemaVersion: 1, runId }) + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
} catch (error) {
  if (error && error.code === "EEXIST") fail("openshell_launch_intercept_duplicate");
  fail("openshell_launch_intercept_failed");
}

const recordRoot = "/tmp/nemoclaw-launch-turn-" + runId;
const replacement = [
  ...argv.slice(0, separator + 1),
  "node",
  "-e",
  writerScript,
  runId,
  recordRoot,
  ...remoteArgv,
];
runRealOpenShell(replacement);
`;

// OpenClaw owns the JSONL session store and does not expose a structured
// result from `nemoclaw launch`. This verifier records an in-sandbox baseline,
// then qualifies only complete user and assistant records appended after that
// baseline. Session content never moves to the host.
export const OPENCLAW_SESSION_EVIDENCE_SCRIPT = String.raw`
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [mode, sessionRoot, baselinePath, expectedTurnsText, ptyRecordRoot, runId] =
  process.argv.slice(1);
const baselineTemporaryPath = baselinePath + ".tmp";
const ptyRecordPath = path.join(ptyRecordRoot, "pty-record.json");
const ptyRecordTemporaryPath = path.join(ptyRecordRoot, "pty-record.json.tmp");
const MAX_BASELINE_BYTES = 1024 * 1024;
const MAX_PTY_RECORD_BYTES = 1024;

function finish(exitCode, reason, detail = {}) {
  if (reason) process.stderr.write(JSON.stringify({ reason, ...detail }) + "\n");
  process.exit(exitCode);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function exactMode(stats, mode) {
  return (stats.mode & 0o777) === mode;
}

function validateRunContext() {
  if (!/^[0-9a-f]{32}$/.test(runId || "")) finish(2, "run_id_invalid");
  if (baselinePath !== "/tmp/nemoclaw-launch-session-" + runId + ".json") {
    finish(2, "baseline_path_invalid");
  }
  if (ptyRecordRoot !== "/tmp/nemoclaw-launch-turn-" + runId) {
    finish(2, "pty_record_root_invalid");
  }
}

function readPrivateJson(filePath, maximumBytes, unavailableReason, invalidReason, missingReason) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (missingReason && error && error.code === "ENOENT") finish(1, missingReason);
    finish(2, unavailableReason);
  }
  let raw;
  try {
    const stats = fs.fstatSync(fd);
    if (
      !stats.isFile() ||
      stats.uid !== process.getuid() ||
      !exactMode(stats, 0o600) ||
      stats.nlink !== 1 ||
      stats.size < 2 ||
      stats.size > maximumBytes
    ) {
      finish(2, invalidReason);
    }
    raw = fs.readFileSync(fd, "utf8");
  } catch {
    finish(2, unavailableReason);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
  try {
    return JSON.parse(raw);
  } catch {
    finish(2, invalidReason);
  }
}

function writePrivateJsonAtomic(filePath, temporaryPath, value, maximumBytes, reason) {
  const body = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(body) > maximumBytes) finish(2, reason);
  let fd;
  let created = false;
  try {
    fd = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, body, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryPath, filePath);
    const directoryFd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    if (created) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {}
    }
    finish(2, reason);
  }
}

function completeOffset(raw) {
  return raw.endsWith("\n") ? raw.length : raw.lastIndexOf("\n") + 1;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sessionFileNames() {
  try {
    return fs
      .readdirSync(sessionRoot)
      .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".trajectory.jsonl"))
      .sort();
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    finish(2, "session_store_unreadable");
  }
}

function qualifyTuiInputMode() {
  let rootStats;
  try {
    rootStats = fs.lstatSync(ptyRecordRoot);
  } catch (error) {
    if (error && error.code === "ENOENT") finish(1, "pty_record_missing");
    finish(2, "pty_record_root_unavailable");
  }
  if (
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink() ||
    rootStats.uid !== process.getuid() ||
    !exactMode(rootStats, 0o700)
  ) {
    finish(2, "pty_record_root_invalid");
  }
  const record = readPrivateJson(
    ptyRecordPath,
    MAX_PTY_RECORD_BYTES,
    "pty_record_unavailable",
    "pty_record_invalid",
    "pty_record_missing",
  );
  if (
    !exactKeys(record, ["schemaVersion", "runId", "ttyPath", "dev", "ino", "rdev"]) ||
    record.schemaVersion !== 1 ||
    record.runId !== runId ||
    !/^\/dev\/pts\/\d+$/.test(record.ttyPath || "") ||
    ![record.dev, record.ino, record.rdev].every(
      (value) => typeof value === "string" && /^(0|[1-9]\d{0,24})$/.test(value),
    )
  ) {
    finish(2, "pty_record_invalid");
  }
  let ttyStats;
  try {
    ttyStats = fs.lstatSync(record.ttyPath, { bigint: true });
  } catch {
    finish(2, "pty_identity_changed");
  }
  if (!ttyStats.isCharacterDevice()) finish(2, "pty_not_character_device");
  if (
    ttyStats.dev.toString() !== record.dev ||
    ttyStats.ino.toString() !== record.ino ||
    ttyStats.rdev.toString() !== record.rdev
  ) {
    finish(2, "pty_identity_changed");
  }
  let state;
  try {
    state = childProcess.execFileSync("stty", ["-F", record.ttyPath, "-a"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
  } catch {
    finish(2, "pty_termios_unavailable");
  }
  if (!/(^|[\s;])-icanon([\s;]|$)/.test(state)) finish(1, "pty_input_canonical");
  finish(0);
}

function readCompleteSession(fileName) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(sessionRoot, fileName), "utf8");
  } catch {
    finish(2, "session_unreadable", { sessionId: fileName.slice(0, -6) });
  }
  const offset = completeOffset(raw);
  return { offset, complete: raw.slice(0, offset), raw };
}

function recordBaseline() {
  const sessions = {};
  for (const fileName of sessionFileNames()) {
    const { offset, complete } = readCompleteSession(fileName);
    sessions[fileName] = { offset, digest: digest(complete) };
  }
  writePrivateJsonAtomic(
    baselinePath,
    baselineTemporaryPath,
    { schemaVersion: 1, sessions },
    MAX_BASELINE_BYTES,
    "baseline_write_failed",
  );
  finish(0);
}

function readBaseline() {
  const value = readPrivateJson(
    baselinePath,
    MAX_BASELINE_BYTES,
    "baseline_unreadable",
    "baseline_invalid",
  );
  if (
    !exactKeys(value, ["schemaVersion", "sessions"]) ||
    value.schemaVersion !== 1 ||
    !value.sessions ||
    typeof value.sessions !== "object" ||
    Array.isArray(value.sessions)
  ) {
    finish(2, "baseline_invalid");
  }
  for (const [fileName, entry] of Object.entries(value.sessions)) {
    if (
      !/^[^/]+\.jsonl$/.test(fileName) ||
      !exactKeys(entry, ["offset", "digest"]) ||
      !Number.isSafeInteger(entry.offset) ||
      entry.offset < 0 ||
      typeof entry.digest !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.digest)
    ) {
      finish(2, "baseline_invalid");
    }
  }
  return value.sessions;
}

function validateCleanupFile(filePath, maximumBytes, reason) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    finish(2, reason);
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== process.getuid() ||
    !exactMode(stats, 0o600) ||
    stats.nlink !== 1 ||
    stats.size > maximumBytes
  ) {
    finish(2, reason);
  }
  return true;
}

function fsyncParent(filePath) {
  const fd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function removeBaseline() {
  const baselineExists = validateCleanupFile(
    baselinePath,
    MAX_BASELINE_BYTES,
    "baseline_cleanup_failed",
  );
  if (baselineExists) {
    readBaseline();
    try {
      fs.unlinkSync(baselinePath);
      fsyncParent(baselinePath);
    } catch {
      finish(2, "baseline_cleanup_failed");
    }
  }
  const temporaryExists = validateCleanupFile(
    baselineTemporaryPath,
    MAX_BASELINE_BYTES,
    "baseline_cleanup_failed",
  );
  if (temporaryExists) {
    try {
      fs.unlinkSync(baselineTemporaryPath);
      fsyncParent(baselineTemporaryPath);
    } catch {
      finish(2, "baseline_cleanup_failed");
    }
  }
  finish(0);
}

function removePtyRecordRoot() {
  let before;
  try {
    before = fs.lstatSync(ptyRecordRoot, { bigint: true });
  } catch (error) {
    if (error && error.code === "ENOENT") finish(0);
    finish(2, "pty_record_cleanup_failed");
  }
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.uid !== BigInt(process.getuid()) ||
    (before.mode & 0o777n) !== 0o700n
  ) {
    finish(2, "pty_record_cleanup_failed");
  }
  let names;
  try {
    names = fs.readdirSync(ptyRecordRoot).sort();
  } catch {
    finish(2, "pty_record_cleanup_failed");
  }
  const allowedNames = ["pty-record.json", "pty-record.json.tmp"];
  if (names.some((name) => !allowedNames.includes(name))) {
    finish(2, "pty_record_cleanup_unknown_entry");
  }
  for (const name of names) {
    const filePath = path.join(ptyRecordRoot, name);
    if (!validateCleanupFile(filePath, MAX_PTY_RECORD_BYTES, "pty_record_cleanup_failed")) {
      finish(2, "pty_record_cleanup_failed");
    }
    if (name === "pty-record.json") {
      const record = readPrivateJson(
        filePath,
        MAX_PTY_RECORD_BYTES,
        "pty_record_cleanup_failed",
        "pty_record_cleanup_failed",
      );
      if (!exactKeys(record, ["schemaVersion", "runId", "ttyPath", "dev", "ino", "rdev"])) {
        finish(2, "pty_record_cleanup_failed");
      }
      if (record.schemaVersion !== 1 || record.runId !== runId) {
        finish(2, "pty_record_cleanup_failed");
      }
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      finish(2, "pty_record_cleanup_failed");
    }
  }
  let after;
  try {
    after = fs.lstatSync(ptyRecordRoot, { bigint: true });
  } catch {
    finish(2, "pty_record_cleanup_failed");
  }
  if (after.dev !== before.dev || after.ino !== before.ino) {
    finish(2, "pty_record_cleanup_failed");
  }
  try {
    fs.rmdirSync(ptyRecordRoot);
    fsyncParent(ptyRecordRoot);
  } catch {
    finish(2, "pty_record_cleanup_failed");
  }
  finish(0);
}

function hasStructuredContent(message) {
  if (typeof message.content === "string") return message.content.length > 0;
  return Array.isArray(message.content) && message.content.length > 0;
}

function appendedMessages(fileName, baseline) {
  const { offset, complete, raw } = readCompleteSession(fileName);
  const prior = baseline[fileName];
  const priorOffset = prior ? prior.offset : 0;
  if (raw.length !== offset) {
    finish(2, "session_record_incomplete", { sessionId: fileName.slice(0, -6) });
  }
  if (offset < priorOffset) finish(2, "session_truncated", { sessionId: fileName.slice(0, -6) });
  if (prior && digest(raw.slice(0, priorOffset)) !== prior.digest) {
    finish(2, "session_rewritten", { sessionId: fileName.slice(0, -6) });
  }

  const messages = [];
  for (const line of complete.slice(priorOffset).split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      finish(2, "malformed_session", { sessionId: fileName.slice(0, -6) });
    }
    if (!record || record.type !== "message" || !record.message) continue;
    const role = record.message.role;
    if (role !== "user" && role !== "assistant") continue;
    messages.push({ role, hasStructuredContent: hasStructuredContent(record.message) });
  }
  return messages;
}

function qualifyTurns() {
  const expectedTurns = Number(expectedTurnsText);
  if (!Number.isSafeInteger(expectedTurns) || expectedTurns < 1) {
    finish(2, "expected_turn_count_invalid");
  }

  const baseline = readBaseline();
  const currentFiles = sessionFileNames();
  for (const fileName of Object.keys(baseline)) {
    if (!currentFiles.includes(fileName)) {
      finish(2, "session_removed", { sessionId: fileName.slice(0, -6) });
    }
  }

  const changedSessions = currentFiles
    .map((fileName) => ({
      sessionId: fileName.slice(0, -6),
      messages: appendedMessages(fileName, baseline),
    }))
    .filter((session) => session.messages.length > 0);
  if (changedSessions.length === 0) finish(1);
  if (changedSessions.length > 1) finish(2, "multiple_sessions_changed");

  const { messages, sessionId } = changedSessions[0];
  const expectedRoles = Array.from({ length: expectedTurns }, () => ["user", "assistant"]).flat();
  for (const [index, message] of messages.entries()) {
    if (index >= expectedRoles.length) finish(2, "extra_message", { sessionId });
    if (message.role !== expectedRoles[index]) {
      finish(2, "message_order_invalid", { sessionId });
    }
    if (!message.hasStructuredContent) finish(2, "message_content_empty", { sessionId });
  }
  if (messages.length < expectedRoles.length) finish(1);
  finish(0);
}

try {
  validateRunContext();
  if (mode === "baseline") recordBaseline();
  if (mode === "input-mode") qualifyTuiInputMode();
  if (mode === "qualify") qualifyTurns();
  if (mode === "cleanup-baseline") removeBaseline();
  if (mode === "cleanup-pty") removePtyRecordRoot();
} catch {
  finish(2, "verifier_failed");
}
finish(2, "mode_invalid");
`;

export const LAUNCH_TURN_SCRIPT = String.raw`set -euo pipefail
umask 077
command -v script >/dev/null 2>&1
command -v timeout >/dev/null 2>&1

session_dir="$(mktemp -d "$NEMOCLAW_LAUNCH_HOST_TMP_ROOT/nemoclaw-launch-host.XXXXXX")"
capture="$session_dir/terminal.log"
driver_error="$session_dir/pty-driver.err"
evidence_error="$session_dir/session-evidence.err"
input="$session_dir/input"
openshell_shim="$session_dir/openshell-launch-shim"
intercept_path="$session_dir/launch-intercept.json"
baseline_path="/tmp/nemoclaw-launch-session-$NEMOCLAW_LAUNCH_RUN_ID.json"
pty_record_root="/tmp/nemoclaw-launch-turn-$NEMOCLAW_LAUNCH_RUN_ID"
session_pid=""
session_deadline=""

remove_session_baseline() {
  session_evidence cleanup-baseline
}

remove_pty_record() {
  session_evidence cleanup-pty
}

cleanup() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT
  exec 3>&- 2>/dev/null || true
  if [[ -n "$session_pid" ]] && kill -0 "$session_pid" 2>/dev/null; then
    kill -TERM "$session_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$session_pid" 2>/dev/null || true
  fi
  if [[ -n "$session_pid" ]]; then
    wait "$session_pid" 2>/dev/null || true
  fi
  if ! remove_pty_record >/dev/null 2>&1; then
    echo "launch PTY record cleanup failed" >&2
    cleanup_status=1
  fi
  if ! remove_session_baseline >/dev/null 2>&1; then
    echo "structured session baseline cleanup failed" >&2
    cleanup_status=1
  fi
  if ! rm -rf -- "$session_dir"; then
    echo "launch host session cleanup failed" >&2
    cleanup_status=1
  fi
  if [[ "$original_status" != 0 ]]; then
    exit "$original_status"
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT

terminal_diagnostic() {
  if [[ -f "$capture" ]]; then
    echo "bounded terminal diagnostic (last 4096 bytes):" >&2
    tail -c 4096 "$capture" >&2 || true
  fi
  if [[ -s "$driver_error" ]]; then
    echo "bounded PTY driver diagnostic (last 2048 bytes):" >&2
    tail -c 2048 "$driver_error" >&2 || true
  fi
}

fail_launch_session() {
  echo "$1" >&2
  if [[ -s "$evidence_error" ]]; then
    tail -c 2048 "$evidence_error" >&2 || true
  fi
  terminal_diagnostic
  exit 1
}

session_evidence() {
  local mode="$1"
  local expected_turns=""
  local command_timeout=10
  if [[ "$#" -gt 1 ]]; then
    expected_turns="$2"
  fi
  if [[ -n "$session_deadline" && "$mode" != cleanup-* ]]; then
    local remaining=$((session_deadline - SECONDS))
    if (( remaining <= 0 )); then
      return 1
    fi
    if (( remaining < command_timeout )); then
      command_timeout="$remaining"
    fi
  fi
  timeout --kill-after=1s "$command_timeout"s \
    "$NEMOCLAW_OPENSHELL_COMMAND" sandbox exec \
    --name "$NEMOCLAW_LAUNCH_SANDBOX" -- \
    node -e "$NEMOCLAW_LAUNCH_SESSION_EVIDENCE_SCRIPT" \
    "$mode" \
    "$NEMOCLAW_LAUNCH_SESSION_ROOT" \
    "$baseline_path" \
    "$expected_turns" \
    "$pty_record_root" \
    "$NEMOCLAW_LAUNCH_RUN_ID"
}

wait_for_turn_count() {
  local expected_turns="$1"
  local evidence_status
  while (( SECONDS < session_deadline )); do
    if session_evidence qualify "$expected_turns" >/dev/null 2>"$evidence_error"; then
      return 0
    else
      evidence_status=$?
    fi
    if [[ "$evidence_status" != 1 ]]; then
      fail_launch_session "structured session evidence was invalid or unavailable (status $evidence_status)"
    fi
    if ! kill -0 "$session_pid" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  fail_launch_session "launch did not record the required structured session turns"
}

wait_for_pty_input_mode() {
  local evidence_status
  while (( SECONDS < session_deadline )); do
    if session_evidence input-mode >/dev/null 2>"$evidence_error"; then
      return 0
    else
      evidence_status=$?
    fi
    if [[ "$evidence_status" != 1 ]]; then
      fail_launch_session "OpenClaw TUI input-mode evidence was invalid or unavailable (status $evidence_status)"
    fi
    if ! kill -0 "$session_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  fail_launch_session "launch did not provide a recorded PTY in noncanonical input mode before the session deadline or PTY child exit"
}

if ! session_evidence baseline >/dev/null 2>"$evidence_error"; then
  fail_launch_session "launch could not record the structured session baseline"
fi

printf '%s' "$NEMOCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT" >"$openshell_shim"
chmod 700 "$openshell_shim"

mkfifo -m 600 "$input"
if [[ -n "$NEMOCLAW_LAUNCH_ENTRYPOINT" ]]; then
  printf -v launch_command '%q %q %q %q' \
    "$NEMOCLAW_LAUNCH_COMMAND" "$NEMOCLAW_LAUNCH_ENTRYPOINT" \
    launch "$NEMOCLAW_LAUNCH_SANDBOX"
else
  printf -v launch_command '%q %q %q' \
    "$NEMOCLAW_LAUNCH_COMMAND" launch "$NEMOCLAW_LAUNCH_SANDBOX"
fi

NEMOCLAW_OPENSHELL_BIN="$openshell_shim" \
NEMOCLAW_LAUNCH_INTERCEPT_PATH="$intercept_path" \
NEMOCLAW_LAUNCH_PTY_RECORD_WRITER_SCRIPT="$NEMOCLAW_LAUNCH_PTY_RECORD_WRITER_SCRIPT" \
NEMOCLAW_LAUNCH_RUNTIME_ENV_SCRIPT="$NEMOCLAW_LAUNCH_RUNTIME_ENV_SCRIPT" \
timeout --kill-after=5s 250s \
  script --quiet --return --flush --command "$launch_command" "$capture" \
  <"$input" >/dev/null 2>"$driver_error" &
session_pid=$!
exec 3>"$input"
session_budget_seconds="$NEMOCLAW_LAUNCH_SESSION_BUDGET_SECONDS"
session_deadline=$((SECONDS + session_budget_seconds))

capture_ready=0
while (( SECONDS < session_deadline )); do
  if [[ -f "$capture" ]]; then
    capture_ready=1
    break
  fi
  if ! kill -0 "$session_pid" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if [[ "$capture_ready" != 1 ]]; then
  fail_launch_session "launch did not create a PTY diagnostic capture"
fi

wait_for_pty_input_mode
if ! printf '%s\r' "$NEMOCLAW_LAUNCH_FIRST_INPUT" >&3; then
  fail_launch_session "launch exited before the first PTY input was submitted"
fi
wait_for_turn_count 1
if ! printf '%s\r' "$NEMOCLAW_LAUNCH_SECOND_INPUT" >&3; then
  fail_launch_session "launch exited before the second PTY input was submitted"
fi
wait_for_turn_count 2

if [[ -n "$NEMOCLAW_LAUNCH_EXIT_COMMAND" ]]; then
  printf '%s\r' "$NEMOCLAW_LAUNCH_EXIT_COMMAND" >&3
else
  # Some TUIs have no exit command. They may close the FIFO after the first
  # interrupt, so ignore SIGPIPE while sending the second one.
  trap '' PIPE
  printf '\003' >&3 2>/dev/null || true
  sleep 1
  printf '\003' >&3 2>/dev/null || true
  trap - PIPE
fi
exec 3>&-

if wait "$session_pid"; then
  launch_status=0
else
  launch_status=$?
fi
session_pid=""

if [[ "$launch_status" != 0 ]]; then
  echo "launch exited with status $launch_status" >&2
  terminal_diagnostic
  exit "$launch_status"
fi
if session_evidence qualify 2 >/dev/null 2>"$evidence_error"; then
  :
else
  evidence_status=$?
  fail_launch_session "launch final structured session evidence did not qualify (status $evidence_status)"
fi
if ! remove_session_baseline >/dev/null 2>"$evidence_error"; then
  fail_launch_session "launch could not remove the structured session baseline"
fi
if ! remove_pty_record >/dev/null 2>"$evidence_error"; then
  fail_launch_session "launch could not remove the PTY record"
fi
`;

export interface OpenClawLaunchSessionOptions {
  artifactName: string;
  cliCommand: string;
  cliEntrypoint?: string;
  env: NodeJS.ProcessEnv;
  exitCommand?: string;
  host: HostCliClient;
  redactionValues: string[];
  sandboxName: string;
  beforeLaunchTurns?: () => Promise<void> | void;
}

function uniqueTurnInputs(): { first: string; second: string } {
  const fragment = randomUUID().replaceAll("-", "");
  return {
    first: `Reply briefly without using tools. Request identifier: ${fragment.slice(0, 16)}.`,
    second: `Reply briefly again without using tools. Request identifier: ${fragment.slice(16)}.`,
  };
}

export async function runOpenClawLaunchSession(
  options: OpenClawLaunchSessionOptions,
): Promise<ShellProbeResult> {
  if (process.platform !== "linux") {
    throw new Error("launch session coverage requires the Linux util-linux PTY driver");
  }
  if (!options.host.openshellCommandPath.startsWith("/")) {
    throw new Error("launch session coverage requires an absolute OpenShell command path");
  }
  const inputs = uniqueTurnInputs();
  const result = await options.host.command("bash", ["-lc", LAUNCH_TURN_SCRIPT], {
    artifactName: options.artifactName,
    env: {
      ...options.env,
      NEMOCLAW_LAUNCH_COMMAND: options.cliCommand,
      NEMOCLAW_LAUNCH_ENTRYPOINT: options.cliEntrypoint ?? "",
      NEMOCLAW_LAUNCH_EXIT_COMMAND: options.exitCommand ?? "",
      NEMOCLAW_LAUNCH_FIRST_INPUT: inputs.first,
      NEMOCLAW_LAUNCH_HOST_TMP_ROOT: resolve(options.env.TMPDIR || "/tmp"),
      NEMOCLAW_LAUNCH_RUN_ID: randomUUID().replaceAll("-", ""),
      NEMOCLAW_LAUNCH_SANDBOX: options.sandboxName,
      NEMOCLAW_LAUNCH_SESSION_BUDGET_SECONDS: "230",
      NEMOCLAW_LAUNCH_SECOND_INPUT: inputs.second,
      NEMOCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT: OPENCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT,
      NEMOCLAW_LAUNCH_PTY_RECORD_WRITER_SCRIPT: OPENCLAW_PTY_RECORD_WRITER_SCRIPT,
      NEMOCLAW_LAUNCH_RUNTIME_ENV_SCRIPT: OPENCLAW_LAUNCH_RUNTIME_ENV_SCRIPT,
      NEMOCLAW_LAUNCH_SESSION_EVIDENCE_SCRIPT: OPENCLAW_SESSION_EVIDENCE_SCRIPT,
      NEMOCLAW_LAUNCH_SESSION_ROOT: "/sandbox/.openclaw/agents/main/sessions",
      NEMOCLAW_OPENSHELL_COMMAND: options.host.openshellCommandPath,
      TERM: "xterm-256color",
    },
    redactionValues: options.redactionValues,
    timeoutMs: 280_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`launch session failed: ${resultText(result)}`);
  }
  return result;
}

export async function runOpenClawLaunchReadinessLeaseTurns(
  options: OpenClawLaunchSessionOptions,
): Promise<void> {
  const probeArgs = options.cliEntrypoint
    ? [options.cliEntrypoint, options.sandboxName, "connect", "--probe-only"]
    : [options.sandboxName, "connect", "--probe-only"];
  const probe = await options.host.command(options.cliCommand, probeArgs, {
    artifactName: `${options.artifactName}-probe`,
    env: options.env,
    redactionValues: options.redactionValues,
    timeoutMs: 360_000,
  });
  if (probe.exitCode !== 0) {
    throw new Error(`launch readiness producer failed: ${resultText(probe)}`);
  }

  await options.beforeLaunchTurns?.();

  for (const ordinal of ["first", "second"] as const) {
    await runOpenClawLaunchSession({
      ...options,
      artifactName: `${options.artifactName}-${ordinal}`,
    });
  }
}
