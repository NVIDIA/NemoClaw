#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Run one openclaw agent turn inside the sandbox and check the reply for the
# skill verification token (proves the skill content was available to the agent).
#
# Prereq: skill deployed with test/e2e/e2e-cloud-experimental/fixtures/skill-smoke-template.SKILL.md
# (includes SKILL_SMOKE_VERIFY_K9X2). Re-run add-sandbox-skill.sh after template updates.
#
# Usage (from repo root):
#   NVIDIA_API_KEY=nvapi-... SANDBOX_NAME=test01 SKILL_ID=skill-smoke-fixture \
#     bash test/e2e/e2e-cloud-experimental/features/skill/verify-sandbox-skill-via-agent.sh
#
# Optional:
#   SKILL_VERIFY_PROMPT — override user message (still must elicit VERIFY_TOKEN in practice)
#   VERIFY_TOKEN — default SKILL_SMOKE_VERIFY_K9X2
#   SKILL_VERIFY_SESSION_ID — default unique id (time + RANDOMs) to avoid jsonl.lock collisions
#   SKILL_VERIFY_NO_CLEAR_LOCK=1 — do not rm stale .jsonl.lock for this session before agent (debug only)
#   OPENCLAW_AGENT_PREFIX — default "nemoclaw-start" (run before openclaw agent, same as telegram-bridge)

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-}}"
SKILL_ID="${SKILL_ID:-skill-smoke-fixture}"
VERIFY_TOKEN="${VERIFY_TOKEN:-SKILL_SMOKE_VERIFY_K9X2}"
OPENCLAW_AGENT_PREFIX="${OPENCLAW_AGENT_PREFIX:-nemoclaw-start}"
AGENT_LAUNCHER=""
[ -n "$OPENCLAW_AGENT_PREFIX" ] && AGENT_LAUNCHER="${OPENCLAW_AGENT_PREFIX} "
SESSION_ID="${SKILL_VERIFY_SESSION_ID:-skill-verify-$(date +%s)-${RANDOM}-${RANDOM}-${RANDOM}}"

die() {
  printf '%s\n' "verify-sandbox-skill-via-agent: FAIL: $*" >&2
  exit 1
}
ok() { printf '%s\n' "verify-sandbox-skill-via-agent: OK: $*"; }
info() { printf '%s\n' "verify-sandbox-skill-via-agent: INFO: $*"; }

[ -n "$SANDBOX_NAME" ] || die "set SANDBOX_NAME (or NEMOCLAW_SANDBOX_NAME)"
[ -n "${NVIDIA_API_KEY:-}" ] || die "set NVIDIA_API_KEY (needed for inference inside sandbox)"

DEFAULT_PROMPT="Use the OpenClaw managed skill named '${SKILL_ID}'. Read its SKILL.md. Reply with ONLY this exact verification token string and nothing else: ${VERIFY_TOKEN}"
PROMPT="${SKILL_VERIFY_PROMPT:-$DEFAULT_PROMPT}"

command -v openshell >/dev/null 2>&1 || die "openshell not on PATH"
command -v base64 >/dev/null 2>&1 || die "base64 not on PATH"

prompt_b64=$(printf '%s' "$PROMPT" | base64 | tr -d '\n')
nv_b64=$(printf '%s' "$NVIDIA_API_KEY" | base64 | tr -d '\n')

ssh_config="$(mktemp)"
trap 'rm -f "$ssh_config"' EXIT
openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null \
  || die "openshell sandbox ssh-config failed for '${SANDBOX_NAME}'"

TIMEOUT_CMD=""
command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout 180"
command -v gtimeout >/dev/null 2>&1 && TIMEOUT_CMD="gtimeout 180"

# Remote: decode prompt + key, drop stale session lock for *this* session id (leftover from crashed agent), then run agent.
# OpenClaw stores sessions under /sandbox/.openclaw-data in NemoClaw sandboxes.
_lock_rm=""
if [ "${SKILL_VERIFY_NO_CLEAR_LOCK:-0}" != "1" ]; then
  _lock_rm="rm -f '/sandbox/.openclaw-data/agents/main/sessions/${SESSION_ID}.jsonl.lock' 2>/dev/null || true; "
fi
remote_cmd="pm=\$(printf '%s' '${prompt_b64}' | base64 -d) || exit 1; nv=\$(printf '%s' '${nv_b64}' | base64 -d) || exit 1; export NVIDIA_API_KEY=\"\$nv\"; ${_lock_rm}${AGENT_LAUNCHER}openclaw agent --agent main --local -m \"\$pm\" --session-id '${SESSION_ID}'"

info "Running openclaw agent in sandbox '${SANDBOX_NAME}' (session ${SESSION_ID})..."

set +e
raw_out=$(
  $TIMEOUT_CMD ssh -T -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "$remote_cmd" 2>&1
)
agent_rc=$?
set -e

printf '\n%s\n' "--- agent stdout/stderr (trimmed for display) ---"
printf '%s' "$raw_out" | tail -c 12000
printf '\n%s\n' "--- end ---"

# Collapse newlines so a model-wrapped token (e.g. "SKILL_SMOKE_VER\nIFY_K9X2") still matches.
collapsed_out=$(printf '%s' "$raw_out" | tr -d '\n\r')
if printf '%s' "$collapsed_out" | grep -Fq "$VERIFY_TOKEN"; then
  ok "agent output contains ${VERIFY_TOKEN}"
  exit 0
fi

die "token ${VERIFY_TOKEN} not found in agent output (ssh/agent exit ${agent_rc}). Hints: session file locked → stale .jsonl.lock (this script clears it for the chosen session id) or kill stuck openclaw in sandbox; [tools] ENOENT on skills → re-run add-sandbox-skill.sh. Session was: ${SESSION_ID}"
