// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

// The live driver points only the `nemoclaw launch` process at this shim. The
// shim passes every OpenShell call through unchanged except the exact TTY exec
// that starts OpenClaw, where it attaches the non-secret run identity through
// OpenShell's supported request environment. The TUI inherits that identity,
// allowing readiness to bind to this launch instead of a process-table peer.
export const OPENCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT = String.raw`#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");

const argv = process.argv.slice(2);
const realOpenShell = process.env.NEMOCLAW_LAUNCH_REAL_OPENSHELL;
const runId = process.env.NEMOCLAW_LAUNCH_RUN_ID;
const sandboxName = process.env.NEMOCLAW_LAUNCH_SANDBOX;
const interceptPath = process.env.NEMOCLAW_LAUNCH_INTERCEPT_PATH;

function fail(reason) {
  process.stderr.write(JSON.stringify({ reason }) + "\n");
  process.exit(73);
}

function run(nextArgv) {
  const result = childProcess.spawnSync(realOpenShell, nextArgv, { stdio: "inherit" });
  if (result.error || result.status === null) fail("openshell_shim_invocation_failed");
  process.exit(result.status);
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

if (!realOpenShell || !realOpenShell.startsWith("/")) fail("openshell_shim_authority_invalid");
if (!/^[0-9a-f]{32}$/.test(runId || "")) fail("openshell_shim_run_id_invalid");
if (!interceptPath || !interceptPath.startsWith("/")) fail("openshell_shim_path_invalid");

const separator = argv.indexOf("--");
const remoteArgv = separator === -1 ? [] : argv.slice(separator + 1);
const expectedTail = ["bash", "-lc", "openclaw tui"];
let optionIndex = 4;
if (argv[optionIndex] === "-g") optionIndex += 2;
const launchLike =
  argv[0] === "sandbox" &&
  argv[1] === "exec" &&
  argv[2] === "--name" &&
  argv[3] === sandboxName &&
  arraysEqual(argv.slice(optionIndex, separator), ["--tty", "--timeout", "0"]) &&
  remoteArgv.length >= expectedTail.length &&
  expectedTail.every((value, index) => value === remoteArgv.at(index - expectedTail.length));

if (!launchLike) run(argv);
try {
  fs.writeFileSync(interceptPath, runId + "\n", { flag: "wx", mode: 0o600 });
} catch {
  fail("openshell_launch_intercept_duplicate");
}
run([
  ...argv.slice(0, separator),
  "--env",
  "NEMOCLAW_LAUNCH_RUN_ID=" + runId,
  ...argv.slice(separator),
]);
`;

// OpenClaw owns the JSONL session store and does not expose a structured
// result from `nemoclaw launch`. This verifier records an in-sandbox baseline,
// then qualifies only complete user and assistant records appended after that
// baseline. Session content never moves to the host.
export const OPENCLAW_SESSION_EVIDENCE_SCRIPT = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [mode, sessionRoot, baselinePath, expectedTurnsText, runId] = process.argv.slice(1);

function finish(exitCode, reason, detail = {}) {
  if (reason) process.stderr.write(JSON.stringify({ reason, ...detail }) + "\n");
  process.exit(exitCode);
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

function launchOwnedOpenClawTuiProcessIds() {
  let names;
  try {
    names = fs.readdirSync("/proc");
  } catch {
    finish(2, "process_table_unreadable");
  }
  const pids = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let args;
    try {
      args = fs
        .readFileSync(path.join("/proc", name, "cmdline"))
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
    } catch {
      continue;
    }
    if (!args.includes("tui")) continue;
    if (!args.some((arg) => ["openclaw", "openclaw.mjs"].includes(path.basename(arg)))) continue;
    let environment;
    try {
      environment = fs.readFileSync(path.join("/proc", name, "environ"), "utf8").split("\0");
    } catch (error) {
      if (error && ["ENOENT", "ESRCH"].includes(error.code)) continue;
      finish(2, "tui_environment_unavailable");
    }
    if (environment.includes("NEMOCLAW_LAUNCH_RUN_ID=" + runId)) pids.push(name);
  }
  return pids;
}

// The terminal line discipline safely queues a complete submitted line even
// while a canonical-mode TUI is still installing its reader. Raw mode is a UI
// implementation detail. Readiness therefore requires the exact run identity
// injected into this launch's remote exec and a PTY on that process's fd 0.
function qualifyTuiInputPty() {
  if (!/^[0-9a-f]{32}$/.test(runId || "")) finish(2, "launch_run_id_invalid");
  const pids = launchOwnedOpenClawTuiProcessIds();
  if (pids.length === 0) finish(1);
  if (pids.length > 1) finish(2, "multiple_launch_tui_processes");
  let ttyPath;
  try {
    ttyPath = fs.realpathSync(path.join("/proc", pids[0], "fd", "0"));
  } catch (error) {
    if (error && ["ENOENT", "ESRCH"].includes(error.code)) finish(1);
    finish(2, "tui_stdin_unavailable");
  }
  if (!/^\/dev\/pts\/\d+$/.test(ttyPath)) finish(2, "tui_stdin_not_pty");
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
  try {
    fs.writeFileSync(
      baselinePath,
      JSON.stringify({ schemaVersion: 1, sessions }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch {
    finish(2, "baseline_write_failed");
  }
  finish(0);
}

function readBaseline() {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch {
    finish(2, "baseline_unreadable");
  }
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !value.sessions ||
    typeof value.sessions !== "object" ||
    Array.isArray(value.sessions)
  ) {
    finish(2, "baseline_invalid");
  }
  for (const entry of Object.values(value.sessions)) {
    if (
      !entry ||
      typeof entry !== "object" ||
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
  if (mode === "baseline") recordBaseline();
  if (mode === "input-pty") qualifyTuiInputPty();
  if (mode === "qualify") qualifyTurns();
} catch {
  finish(2, "verifier_failed");
}
finish(2, "mode_invalid");
`;

export const LAUNCH_TURN_SCRIPT = String.raw`set -euo pipefail
command -v script >/dev/null 2>&1
command -v timeout >/dev/null 2>&1

session_dir="$(mktemp -d /tmp/nemoclaw-launch-turn.XXXXXX)"
capture="$session_dir/terminal.log"
driver_error="$session_dir/pty-driver.err"
evidence_error="$session_dir/session-evidence.err"
input="$session_dir/input"
input_submitted_marker="$session_dir/input-submitted"
openshell_shim="$session_dir/openshell-launch-shim"
intercept_path="$session_dir/launch-intercept"
baseline_path="/tmp/nemoclaw-launch-session-$NEMOCLAW_LAUNCH_RUN_ID.json"
session_pid=""
session_deadline=""

remove_session_baseline() {
  "$NEMOCLAW_OPENSHELL_COMMAND" sandbox exec \
    --name "$NEMOCLAW_LAUNCH_SANDBOX" -- \
    rm -f -- "$baseline_path"
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
  if ! remove_session_baseline >/dev/null 2>&1; then
    echo "structured session baseline cleanup failed" >&2
    cleanup_status=1
  fi
  rm -rf -- "$session_dir"
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
  if [[ -n "$session_deadline" ]]; then
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

wait_for_tui_input_pty() {
  local evidence_status
  while (( SECONDS < session_deadline )); do
    if session_evidence input-pty >/dev/null 2>"$evidence_error"; then
      return 0
    else
      evidence_status=$?
    fi
    if [[ "$evidence_status" != 1 ]]; then
      fail_launch_session "OpenClaw TUI input PTY evidence was invalid or unavailable (status $evidence_status)"
    fi
    if ! kill -0 "$session_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  fail_launch_session "OpenClaw TUI did not attach standard input to the launch PTY before the session deadline"
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

NEMOCLAW_LAUNCH_INPUT_SUBMITTED_MARKER="$input_submitted_marker" \
NEMOCLAW_LAUNCH_INTERCEPT_PATH="$intercept_path" \
NEMOCLAW_LAUNCH_REAL_OPENSHELL="$NEMOCLAW_OPENSHELL_COMMAND" \
NEMOCLAW_OPENSHELL_BIN="$openshell_shim" \
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

wait_for_tui_input_pty
if ! printf '%s\r' "$NEMOCLAW_LAUNCH_FIRST_INPUT" >&3; then
  fail_launch_session "launch exited before the first PTY input was submitted"
fi
: >"$input_submitted_marker"
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
      NEMOCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT: OPENCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT,
      NEMOCLAW_LAUNCH_RUN_ID: randomUUID().replaceAll("-", ""),
      NEMOCLAW_LAUNCH_SANDBOX: options.sandboxName,
      NEMOCLAW_LAUNCH_SESSION_BUDGET_SECONDS: "230",
      NEMOCLAW_LAUNCH_SECOND_INPUT: inputs.second,
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
