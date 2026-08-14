// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const EXPECTED_REPLY = "PONG";
const PROMPT =
  "Reply with the one uppercase word formed by the letters P, O, N, G in that order. Do not use tools.";

export const LAUNCH_TURN_SCRIPT = String.raw`set -euo pipefail
command -v script >/dev/null 2>&1
command -v timeout >/dev/null 2>&1

session_dir="$(mktemp -d /tmp/nemoclaw-launch-turn.XXXXXX)"
capture="$session_dir/terminal.log"
input="$session_dir/input"
session_pid=""

cleanup() {
  exec 3>&- 2>/dev/null || true
  if [[ -n "$session_pid" ]] && kill -0 "$session_pid" 2>/dev/null; then
    kill -TERM "$session_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$session_pid" 2>/dev/null || true
  fi
  if [[ -n "$session_pid" ]]; then
    wait "$session_pid" 2>/dev/null || true
  fi
  rm -rf -- "$session_dir"
}
trap cleanup EXIT

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
  script --quiet --return --flush --command "$launch_command" "$capture" <"$input" &
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
  echo "launch did not create a terminal capture" >&2
  exit 1
fi

if [[ -n "$NEMOCLAW_LAUNCH_READY_TEXT" ]]; then
  ready_seen=0
  for _ in {1..60}; do
    if grep -Fq -- "$NEMOCLAW_LAUNCH_READY_TEXT" "$capture"; then
      ready_seen=1
      break
    fi
    if ! kill -0 "$session_pid" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if [[ "$ready_seen" != 1 ]]; then
    echo "launch did not reach the expected TUI state" >&2
    exit 1
  fi
else
  # Hermes accepts buffered terminal input after its startup render settles.
  sleep 12
fi
response_start="$(wc -c <"$capture")"
printf '%s\r' "$NEMOCLAW_LAUNCH_PROMPT" >&3

reply_seen=0
normalized_response() {
  tail -c "+$((response_start + 1))" "$capture" \
    | sed -E $'s/\x1B][^\x07\x1B]*(\x07|\x1B\\\\)//g' \
    | sed -E $'s|\x1B\\[[0-?]*[ -/]*[@-~]||g' \
    | tr '\r' '\n' \
    | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177'
}
has_exact_reply() {
  normalized_response | awk -v expected="$NEMOCLAW_LAUNCH_EXPECTED_REPLY" '
        {
          line = $0
          sub(/^[[:space:]]+/, "", line)
          sub(/[[:space:]]+$/, "", line)
          if (line == expected) found = 1
        }
        END { exit found ? 0 : 1 }
      '
}
has_post_reply_ready() {
  normalized_response | awk \
    -v expected="$NEMOCLAW_LAUNCH_EXPECTED_REPLY" \
    -v ready="$NEMOCLAW_LAUNCH_POST_REPLY_READY_TEXT" '
      {
        line = $0
        sub(/^[[:space:]]+/, "", line)
        sub(/[[:space:]]+$/, "", line)
        if (line == expected) reply = 1
        if (reply && line == ready) found = 1
      }
      END { exit found ? 0 : 1 }
    '
}
for _ in {1..180}; do
  if has_exact_reply; then
    reply_seen=1
    break
  fi
  if ! kill -0 "$session_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [[ "$reply_seen" = 1 && -n "$NEMOCLAW_LAUNCH_POST_REPLY_READY_TEXT" ]]; then
  post_reply_ready_seen=0
  for _ in {1..60}; do
    if has_post_reply_ready; then
      post_reply_ready_seen=1
      break
    fi
    if ! kill -0 "$session_pid" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if [[ "$post_reply_ready_seen" != 1 ]]; then
    echo "launch did not return to the expected TUI state after the reply" >&2
    exit 1
  fi
fi

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

if [[ "$reply_seen" != 1 ]]; then
  echo "launch did not produce the expected agent reply" >&2
  exit 1
fi
if wait "$session_pid"; then
  launch_status=0
else
  launch_status=$?
fi
session_pid=""
if [[ "$launch_status" != 0 ]]; then
  echo "launch exited with status $launch_status" >&2
  exit "$launch_status"
fi
printf '%s\n' "NEMOCLAW_LAUNCH_TURN_OK"
`;

export interface LaunchAgentTurnOptions {
  artifactName: string;
  cliCommand: string;
  cliEntrypoint?: string;
  env: NodeJS.ProcessEnv;
  exitCommand?: string;
  host: HostCliClient;
  postReplyReadyText?: string;
  readyText?: string;
  redactionValues: string[];
  sandboxName: string;
  expectedReply?: string;
  prompt?: string;
  beforeLaunchTurns?: () => Promise<void> | void;
}

export async function runLaunchAgentTurn(
  options: LaunchAgentTurnOptions,
): Promise<ShellProbeResult> {
  if (process.platform !== "linux") {
    throw new Error("launch agent turn coverage requires the Linux util-linux PTY driver");
  }
  const result = await options.host.command("bash", ["-lc", LAUNCH_TURN_SCRIPT], {
    artifactName: options.artifactName,
    env: {
      ...options.env,
      NEMOCLAW_LAUNCH_COMMAND: options.cliCommand,
      NEMOCLAW_LAUNCH_ENTRYPOINT: options.cliEntrypoint ?? "",
      NEMOCLAW_LAUNCH_EXIT_COMMAND: options.exitCommand ?? "",
      NEMOCLAW_LAUNCH_EXPECTED_REPLY: options.expectedReply ?? EXPECTED_REPLY,
      NEMOCLAW_LAUNCH_PROMPT: options.prompt ?? PROMPT,
      NEMOCLAW_LAUNCH_POST_REPLY_READY_TEXT: options.postReplyReadyText ?? "",
      NEMOCLAW_LAUNCH_READY_TEXT: options.readyText ?? "",
      NEMOCLAW_LAUNCH_SANDBOX: options.sandboxName,
      TERM: "xterm-256color",
    },
    redactionValues: options.redactionValues,
    timeoutMs: 280_000,
  });
  if (result.exitCode !== 0 || !result.stdout.includes("NEMOCLAW_LAUNCH_TURN_OK")) {
    throw new Error(`launch agent turn failed: ${resultText(result)}`);
  }
  return result;
}

function uniqueTurnContract(artifactName: string, ordinal: "FIRST" | "SECOND") {
  const fragment = createHash("sha256")
    .update(`${artifactName}:${ordinal}`)
    .digest("hex")
    .slice(0, 12);
  const expectedReply = `NEMOCLAW_${fragment.toUpperCase()}_${ordinal}_OK`;
  return {
    expectedReply,
    prompt:
      `Join these four fragments with underscores and put only the result on its own line: ` +
      `NEMOCLAW, ${fragment.toUpperCase()}, ${ordinal}, OK. Do not use tools.`,
  };
}

export async function runLaunchReadinessLeaseTurns(options: LaunchAgentTurnOptions): Promise<void> {
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

  for (const ordinal of ["FIRST", "SECOND"] as const) {
    await runLaunchAgentTurn({
      ...options,
      artifactName: `${options.artifactName}-${ordinal.toLowerCase()}`,
      ...uniqueTurnContract(options.artifactName, ordinal),
    });
  }
}
