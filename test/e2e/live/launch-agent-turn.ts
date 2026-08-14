// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

// OpenClaw owns the JSONL session store and does not expose a structured
// result from `nemoclaw launch`. This verifier records an in-sandbox baseline,
// then qualifies only complete user and assistant records appended after that
// baseline. Session content never moves to the host.
export const OPENCLAW_SESSION_EVIDENCE_SCRIPT = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [mode, sessionRoot, baselinePath, expectedTurnsText] = process.argv.slice(1);

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
baseline_path="/tmp/nemoclaw-launch-session-$NEMOCLAW_LAUNCH_RUN_ID.json"
session_pid=""

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
  if [[ "$#" -gt 1 ]]; then
    expected_turns="$2"
  fi
  "$NEMOCLAW_OPENSHELL_COMMAND" sandbox exec \
    --name "$NEMOCLAW_LAUNCH_SANDBOX" -- \
    node -e "$NEMOCLAW_LAUNCH_SESSION_EVIDENCE_SCRIPT" \
    "$mode" \
    "$NEMOCLAW_LAUNCH_SESSION_ROOT" \
    "$baseline_path" \
    "$expected_turns"
}

wait_for_turn_count() {
  local expected_turns="$1"
  local evidence_status
  for _ in {1..180}; do
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

if ! session_evidence baseline >/dev/null 2>"$evidence_error"; then
  fail_launch_session "launch could not record the structured session baseline"
fi

mkfifo -m 600 "$input"
if [[ -n "$NEMOCLAW_LAUNCH_ENTRYPOINT" ]]; then
  printf -v launch_command '%q %q %q %q' \
    "$NEMOCLAW_LAUNCH_COMMAND" "$NEMOCLAW_LAUNCH_ENTRYPOINT" \
    launch "$NEMOCLAW_LAUNCH_SANDBOX"
else
  printf -v launch_command '%q %q %q' \
    "$NEMOCLAW_LAUNCH_COMMAND" launch "$NEMOCLAW_LAUNCH_SANDBOX"
fi

timeout --kill-after=5s 250s \
  script --quiet --return --flush --command "$launch_command" "$capture" \
  <"$input" >/dev/null 2>"$driver_error" &
session_pid=$!
exec 3>"$input"

capture_ready=0
for _ in {1..100}; do
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

printf '%s\r' "$NEMOCLAW_LAUNCH_FIRST_INPUT" >&3
wait_for_turn_count 1
printf '%s\r' "$NEMOCLAW_LAUNCH_SECOND_INPUT" >&3
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
  const inputs = uniqueTurnInputs();
  const result = await options.host.command("bash", ["-lc", LAUNCH_TURN_SCRIPT], {
    artifactName: options.artifactName,
    env: {
      ...options.env,
      NEMOCLAW_LAUNCH_COMMAND: options.cliCommand,
      NEMOCLAW_LAUNCH_ENTRYPOINT: options.cliEntrypoint ?? "",
      NEMOCLAW_LAUNCH_EXIT_COMMAND: options.exitCommand ?? "",
      NEMOCLAW_LAUNCH_FIRST_INPUT: inputs.first,
      NEMOCLAW_LAUNCH_RUN_ID: randomUUID().replaceAll("-", ""),
      NEMOCLAW_LAUNCH_SANDBOX: options.sandboxName,
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
