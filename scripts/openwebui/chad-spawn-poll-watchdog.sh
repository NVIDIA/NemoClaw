#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-spawn-poll-watchdog — host launchd job that runs chad-spawn-poll
# inside the chad pod every 5 minutes.
#
# Why this exists: the openclaw cron version (spawn-poll, */5 * * * *)
# wrapped each invocation in an agent turn — 43,000 input tokens and
# 45-110 seconds of agent time for what is structurally a 5-second
# shell script. 288 ticks/day → ~12.7M tokens/day in agent overhead
# AND 288 chat-session entries cluttering the OpenWebUI UI.
#
# This host-side watchdog (matching the chad-gateway-watchdog pattern)
# does the same work without an agent turn. spawn-poll's own output
# (reconciliations / timeouts / failures) is parsed and:
#
#   1. Appended to /sandbox/.openclaw-data/state/agent-inbox.jsonl as
#      a structured event line that future cron / chat agent turns can
#      consume on startup.
#   2. Echoed into today's memory file under "## Spawn-poll reconciliations"
#      so human reviewers and gbrain-dream pick it up too.
#
# Only NON-TRIVIAL outputs (reconciliations) generate inbox entries —
# the silent "no work to do" runs leave nothing behind, keeping the
# inbox / memory append-only stream meaningful.
#
# Installed as ~/Library/LaunchAgents/dev.nemoclaw.chad-spawn-poll.plist.
# Runs as the host user; no sandbox privileges escalate.

set -uo pipefail

SSH_HOST="${CHAD_SSH_HOST:-openshell-chad}"
SPAWN_POLL="${CHAD_SPAWN_POLL:-/sandbox/.openclaw-data/bin/chad-spawn-poll}"
# Fallback: image-deployed copy if the sandbox-writable shim isn't present
SPAWN_POLL_FALLBACK="${CHAD_SPAWN_POLL_FALLBACK:-/usr/local/bin/chad-spawn-poll}"
INBOX="${CHAD_AGENT_INBOX:-/sandbox/.openclaw-data/state/agent-inbox.jsonl}"
LOG="${CHAD_SPAWN_POLL_WATCHDOG_LOG:-${HOME}/.nemoclaw/openwebui/chad-spawn-poll-watchdog.log}"
MAX_AGE_MIN="${CHAD_SPAWN_POLL_MAX_AGE:-1}"

mkdir -p "$(dirname "$LOG")"

# Bound the local log so it doesn't grow forever. Keep last ~2000 lines (≈20 days at one entry per event).
trim_log() {
  if [ -f "$LOG" ] && [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 2000 ]; then
    tail -1500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { printf '[%s] %s\n' "$(ts)" "$*" >> "$LOG"; }

# Self-heal: the pod's container filesystem resets on pod recreate, so the
# sandbox-writable and image binaries can vanish. Restore from the host copy
# so a fresh pod self-recovers without manual re-provisioning.
PROVISION_SRC="${CHAD_SPAWN_POLL_SRC:-${HOME}/.nemoclaw/source/scripts/chad-cron-wrappers/chad-spawn-poll}"
if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" \
    "test -x '$SPAWN_POLL' -o -x '$SPAWN_POLL_FALLBACK'" 2>/dev/null; then
  if [ -x "$PROVISION_SRC" ]; then
    log "self-heal: uploading chad-spawn-poll to pod"
    cat "$PROVISION_SRC" | ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" \
      "cat > '$SPAWN_POLL' && chmod +x '$SPAWN_POLL'" || {
      log "self-heal: upload failed — using fallback path"
    }
  else
    log "self-heal: host source missing at $PROVISION_SRC"
  fi
fi

# Run the poll. Prefer sandbox-writable copy (allows future patches without
# image rebuild); fall back to image binary.
OUTPUT=$(
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" "
    if [ -x '$SPAWN_POLL' ]; then
      '$SPAWN_POLL' --max-age $MAX_AGE_MIN 2>&1
    elif [ -x '$SPAWN_POLL_FALLBACK' ]; then
      '$SPAWN_POLL_FALLBACK' --max-age $MAX_AGE_MIN 2>&1
    else
      echo 'chad-spawn-poll: binary not found' >&2
      exit 4
    fi
  "
)
RC=$?

# Classify the run. We only want to write to the inbox / today's memory
# when there's a STATE CHANGE — a reconciliation, a timeout, an error.
# A no-op poll (rc=0, output is empty or just "no async gha spawns running")
# leaves no trace beyond the local watchdog log.
event_kind=""
severity=""
case "$OUTPUT" in
  *"reconciled"*"-> failed"*|*"reconciled"*"-> timeout"*)
    event_kind="spawn-reconciled"
    severity="warning"
    ;;
  *"reconciled"*"-> done"*)
    event_kind="spawn-reconciled"
    severity="info"
    ;;
  *"failed"*|*"FAILED"*|*"ERROR"*)
    event_kind="spawn-poll-error"
    severity="error"
    ;;
esac
if [ $RC -ne 0 ]; then
  event_kind="spawn-poll-error"
  severity="error"
fi

# Quiet ticks (most ticks) silent-exit. Local log captures rc + brief summary
# for ops visibility, but nothing reaches the agent-facing surfaces.
if [ -z "$event_kind" ]; then
  log "quiet rc=$RC out=$(printf '%s' "$OUTPUT" | head -c 80)"
  trim_log
  exit 0
fi

# Build the inbox event line (one JSON object per line, append-only).
SUMMARY=$(printf '%s' "$OUTPUT" | head -c 600 | tr '\n' ' ' | sed 's/"/\\"/g')
INBOX_LINE=$(printf '{"ts":"%s","source":"chad-spawn-poll-watchdog","kind":"%s","severity":"%s","exit_code":%d,"summary":"%s"}' \
  "$(ts)" "$event_kind" "$severity" "$RC" "$SUMMARY")

# Append to in-pod inbox + today's memory. Memory append is "best effort" —
# the inbox is the authoritative structured record.
# Note: payloads (inbox line + raw output) travel via stdin, never inlined into
# the remote command string — inlining multi-line output corrupted shell parsing.
printf '%s\n' "$INBOX_LINE" | ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" \
  "cat >> '$INBOX'" >> "$LOG" 2>&1 || true
if [ "$severity" != "info" ] && [ -n "$OUTPUT" ]; then
  printf '%s' "$OUTPUT" | ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" '
    MEM=$(/usr/local/bin/chad-ensure-today-memory 2>/dev/null || /sandbox/.openclaw-data/bin/chad-ensure-today-memory 2>/dev/null || echo "")
    if [ -n "$MEM" ]; then
      {
        echo ""
        echo "## Spawn-poll reconciliations — '"$(ts)"'"
        echo "Severity: '"$severity"'  Exit: '"$RC"'"
        echo "```"
        cat
        echo "```"
      } >> "$MEM"
    fi' >> "$LOG" 2>&1 || true
fi

log "kind=$event_kind severity=$severity rc=$RC summary=$(printf '%s' "$SUMMARY" | head -c 160)"
trim_log
exit 0
