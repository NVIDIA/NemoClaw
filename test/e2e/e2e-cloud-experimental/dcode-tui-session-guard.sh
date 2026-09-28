#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

MODE="${1:-}"
SANDBOX_NAME="${2:-}"
SESSION_ID=""
BASELINE=""
WAIT_TIMEOUT="0"
PROCESS_ROOT="/proc"

if [[ ! "$SANDBOX_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  printf 'invalid sandbox name\n' >&2
  exit 2
fi

case "$MODE" in
  baseline)
    PROCESS_ROOT="${3:-/proc}"
    ;;
  wait)
    BASELINE="${3:-}"
    WAIT_TIMEOUT="${4:-}"
    PROCESS_ROOT="${5:-/proc}"
    if [[ ! "$BASELINE" =~ ^[0-9]+$ ]] || [[ ! "$WAIT_TIMEOUT" =~ ^[0-9]+$ ]]; then
      printf 'invalid TUI wait arguments\n' >&2
      exit 2
    fi
    ;;
  recover)
    SESSION_ID="${3:-}"
    BASELINE="${4:-}"
    PROCESS_ROOT="${5:-/proc}"
    if [[ ! "$SESSION_ID" =~ ^[0-9a-f-]{36}$ ]] || [[ ! "$BASELINE" =~ ^[0-9]+$ ]]; then
      printf 'invalid TUI cleanup arguments\n' >&2
      exit 2
    fi
    ;;
  *)
    printf 'usage: %s baseline SANDBOX | wait SANDBOX BASELINE TIMEOUT | recover SANDBOX SESSION_ID BASELINE\n' "$0" >&2
    exit 2
    ;;
esac

if [[ "$PROCESS_ROOT" != /* ]] || [ ! -d "$PROCESS_ROOT" ]; then
  printf 'invalid process root\n' >&2
  exit 2
fi

guard_script=""
IFS= read -r -d '' guard_script <<'REMOTE' || true
set -euo pipefail
mode="$1"
session_id="$2"
baseline="$3"
wait_timeout="$4"
process_root="$5"
final_count=""

dcode_process_count() {
  local self=$$
  local parent=$PPID
  local count=0 proc_dir pid cmdline lower_cmdline
  for proc_dir in "$process_root"/[0-9]*; do
    pid=${proc_dir##*/}
    case " $self $parent " in *" $pid "*) continue ;; esac
    kill -0 "$pid" 2>/dev/null || continue
    [ -r "$proc_dir/cmdline" ] || continue
    cmdline=$(tr "\000" " " <"$proc_dir/cmdline" 2>/dev/null) || continue
    lower_cmdline=$(printf '%s' "$cmdline" | tr '[:upper:]' '[:lower:]')
    case "$lower_cmdline" in
      *dcode-session-supervisor* | *deepagents_code* | *langgraph* | */opt/venv/bin/dcode*) count=$((count + 1)) ;;
    esac
  done
  printf '%s\n' "$count"
}

wait_for_baseline() {
  local expected="$1"
  local timeout_seconds="$2"
  local deadline=$((SECONDS + timeout_seconds))
  local count
  while :; do
    count=$(dcode_process_count)
    if [ "$count" -le "$expected" ]; then
      final_count="$count"
      printf 'NEMOCLAW_DCODE_PROCESS_COUNT:%s\n' "$count"
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      printf 'NEMOCLAW_DCODE_PROCESS_COUNT:%s\n' "$count"
      printf 'DCode process count %s did not return to baseline %s\n' "$count" "$expected" >&2
      return 4
    fi
    sleep 1
  done
}

tagged_pids() {
  local proc_dir pid
  for proc_dir in "$process_root"/[0-9]*; do
    pid=${proc_dir##*/}
    kill -0 "$pid" 2>/dev/null || continue
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

case "$mode" in
  baseline)
    count=$(dcode_process_count)
    printf 'NEMOCLAW_DCODE_PROCESS_COUNT:%s\n' "$count"
    ;;
  wait)
    wait_for_baseline "$baseline" "$wait_timeout"
    ;;
  recover)
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
    wait_for_baseline "$baseline" 0
    printf 'NEMOCLAW_TUI_CALLER_RECOVERY_OK:%s\n' "$final_count"
    ;;
esac
REMOTE

openshell sandbox exec --name "$SANDBOX_NAME" -- \
  bash -c "$guard_script" nemoclaw-tui-session-guard \
  "$MODE" "$SESSION_ID" "$BASELINE" "$WAIT_TIMEOUT" "$PROCESS_ROOT"
