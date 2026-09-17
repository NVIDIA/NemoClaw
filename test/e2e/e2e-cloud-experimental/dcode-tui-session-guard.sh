#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

MODE="${1:-}"
SANDBOX_NAME="${2:-}"
SESSION_ID="${3:-}"
BASELINE="${4:-}"

if [[ ! "$SANDBOX_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  printf 'invalid sandbox name\n' >&2
  exit 2
fi

# This program expands inside the sandbox.
# shellcheck disable=SC2016
count_script='set -euo pipefail
self=$$
parent=$PPID
count=0
for proc_dir in /proc/[0-9]*; do
  pid=${proc_dir##*/}
  case " $self $parent " in *" $pid "*) continue ;; esac
  [ -r "$proc_dir/cmdline" ] || continue
  cmdline=$(tr "\000" " " <"$proc_dir/cmdline" 2>/dev/null) || continue
  case "${cmdline,,}" in
    *dcode-session-supervisor* | *deepagents_code* | *langgraph* | */opt/venv/bin/dcode*) count=$((count + 1)) ;;
  esac
done
printf "NEMOCLAW_DCODE_PROCESS_COUNT:%s\n" "$count"'

if [ "$MODE" = "baseline" ]; then
  openshell sandbox exec --name "$SANDBOX_NAME" -- bash -c "$count_script"
  exit 0
fi

if [ "$MODE" != "recover" ]; then
  printf 'usage: %s baseline SANDBOX | recover SANDBOX SESSION_ID BASELINE\n' "$0" >&2
  exit 2
fi
if [[ ! "$SESSION_ID" =~ ^[0-9a-f-]{36}$ ]] || [[ ! "$BASELINE" =~ ^[0-9]+$ ]]; then
  printf 'invalid TUI recovery arguments\n' >&2
  exit 2
fi

recovery_script="$(
  cat <<'REMOTE'
set -euo pipefail
session_id="$1"
baseline="$2"

tagged_pids() {
  local proc_dir pid
  for proc_dir in /proc/[0-9]*; do
    pid=${proc_dir##*/}
    [ -r "$proc_dir/environ" ] || continue
    tr "\000" "\n" <"$proc_dir/environ" 2>/dev/null \
      | grep -Fqx -- "NEMOCLAW_TUI_SESSION_ID=$session_id" || continue
    printf '%s\n' "$pid"
  done
}

signal_tagged() {
  local signal="$1" pid
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    kill "-$signal" "$pid" 2>/dev/null || true
  done < <(tagged_pids)
}

signal_tagged TERM
deadline=$((SECONDS + 20))
while [ -n "$(tagged_pids)" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 1; done
signal_tagged KILL
deadline=$((SECONDS + 5))
while [ -n "$(tagged_pids)" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 1; done
remaining=$(tagged_pids)
if [ -n "$remaining" ]; then
  printf 'tagged TUI processes survived: %s\n' "$remaining" >&2
  exit 3
fi

self=$$
parent=$PPID
count=0
for proc_dir in /proc/[0-9]*; do
  pid=${proc_dir##*/}
  case " $self $parent " in *" $pid "*) continue ;; esac
  [ -r "$proc_dir/cmdline" ] || continue
  cmdline=$(tr "\000" " " <"$proc_dir/cmdline" 2>/dev/null) || continue
  case "${cmdline,,}" in
    *dcode-session-supervisor* | *deepagents_code* | *langgraph* | */opt/venv/bin/dcode*) count=$((count + 1)) ;;
  esac
done
printf 'NEMOCLAW_DCODE_PROCESS_COUNT:%s\n' "$count"
if [ "$count" -gt "$baseline" ]; then
  printf 'DCode process count %s did not return to baseline %s\n' "$count" "$baseline" >&2
  exit 4
fi
printf 'NEMOCLAW_TUI_CALLER_RECOVERY_OK:%s\n' "$count"
REMOTE
)"

openshell sandbox exec --name "$SANDBOX_NAME" -- \
  bash -c "$recovery_script" nemoclaw-tui-caller-recovery "$SESSION_ID" "$BASELINE"
