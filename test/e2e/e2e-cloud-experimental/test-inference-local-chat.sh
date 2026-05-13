#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Demo: POST /v1/chat/completions to https://inference.local from *inside* the sandbox (SSH).
# Same idea as test-e2e-cloud-experimental.sh Phase 5b — use this to verify dialogue without the full suite.
#
# Prerequisites:
#   - openshell on PATH, sandbox exists and is Ready
#   - Inference already configured for that sandbox (after onboard)
#   - python3 on host (JSON parse)
#
# Environment (defaults match e2e-cloud-experimental):
#   SANDBOX_NAME or NEMOCLAW_SANDBOX_NAME     — default: e2e-cloud-experimental
#   CLOUD_EXPERIMENTAL_MODEL or NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL / NEMOCLAW_SCENARIO_A_MODEL
#   CHAT_USER_MESSAGE — optional override for the user message (default asks for PONG)
#   DEMO_CHAT_MAX_DISPLAY_CHARS — max chars of assistant text to print (default: 12000; 0 = unlimited)
#   DEMO_CHAT_SHOW_RAW_JSON=1 — also print raw response body (can be large)
#
# Usage (from repo root):
#   bash test/e2e/demo-inference-local-chat.sh
#
# Exit: 0 = assistant text contains PONG (case-insensitive); 1 = failure

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-experimental}}"
CLOUD_EXPERIMENTAL_MODEL="${CLOUD_EXPERIMENTAL_MODEL:-${NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL:-${NEMOCLAW_SCENARIO_A_MODEL:-nvidia/nemotron-3-super-120b-a12b}}}"
CHAT_USER_MESSAGE="${CHAT_USER_MESSAGE:-Reply with exactly one word: PONG}"

die() {
  printf '\033[31m[demo-chat] FAIL:\033[0m %s\n' "$*" >&2
  exit 1
}
ok() { printf '\033[32m[demo-chat] OK:\033[0m %s\n' "$*"; }

DEMO_CHAT_MAX_DISPLAY_CHARS="${DEMO_CHAT_MAX_DISPLAY_CHARS:-12000}"

print_assistant_text() {
  local text=$1
  local n=${#text}
  local max="$DEMO_CHAT_MAX_DISPLAY_CHARS"
  if [ "$max" = "0" ] || [ "$n" -le "$max" ]; then
    printf '%s\n' "$text"
    return
  fi
  printf '%s' "${text:0:max}"
  printf '\n[demo-chat] … truncated for display (%d chars total, DEMO_CHAT_MAX_DISPLAY_CHARS=%s)\n' "$n" "$max"
}

parse_chat_content() {
  python3 -c "
import json, sys
try:
    r = json.load(sys.stdin)
    c = r['choices'][0]['message']
    # Some gateways put interim/final text in \"reasoning\" while content is null
    content = c.get('content') or c.get('reasoning_content') or c.get('reasoning') or ''
    print(content.strip())
except Exception as e:
    print(f'PARSE_ERROR: {e}', file=sys.stderr)
    sys.exit(1)
"
}

command -v python3 >/dev/null 2>&1 || die "python3 not on PATH"
command -v openshell >/dev/null 2>&1 || die "openshell not on PATH"

printf '[demo-chat] sandbox=%s\n' "$SANDBOX_NAME"

payload=$(
  CLOUD_EXPERIMENTAL_MODEL="$CLOUD_EXPERIMENTAL_MODEL" \
    CHAT_USER_MESSAGE="$CHAT_USER_MESSAGE" \
    python3 -c "
import json, os
print(json.dumps({
    'model': os.environ['CLOUD_EXPERIMENTAL_MODEL'],
    'messages': [{'role': 'user', 'content': os.environ['CHAT_USER_MESSAGE']}],
    'max_tokens': 100,
}))
"
) || die "could not build JSON payload"

printf '\n\033[1;36m--- Request ---\033[0m\n'
printf '  URL (inside sandbox): https://inference.local/v1/chat/completions\n'
printf '  model: %s\n' "$CLOUD_EXPERIMENTAL_MODEL"
printf '  user message:\n'
printf '%s\n' "$CHAT_USER_MESSAGE" | sed 's/^/    | /'
printf '  JSON body:\n'
printf '%s\n' "$payload" | python3 -m json.tool 2>/dev/null | sed 's/^/    /' || printf '    %s\n' "$payload"
printf '\n'

TIMEOUT_CMD=""
command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout 120"
command -v gtimeout >/dev/null 2>&1 && TIMEOUT_CMD="gtimeout 120"

ssh_config="$(mktemp)"
trap 'rm -f "$ssh_config"' EXIT

openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null \
  || die "openshell sandbox ssh-config failed for '${SANDBOX_NAME}'"

set +e
out=$(
  $TIMEOUT_CMD ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "curl -sS --max-time 90 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d $(printf '%q' "$payload")" \
    2>&1
)
rc=$?
set -e

[ "$rc" -eq 0 ] || die "ssh/curl exit $rc — ${out:0:500}"
[ -n "$out" ] || die "empty response"

chat_text=$(printf '%s' "$out" | parse_chat_content 2>/dev/null) || chat_text=""

printf '\033[1;36m--- Assistant text (parsed: content | reasoning_content | reasoning) ---\033[0m\n'
if [ -n "$chat_text" ]; then
  print_assistant_text "$chat_text"
else
  printf '  (empty — see raw JSON below if enabled)\n'
fi
printf '\n'

if [ "${DEMO_CHAT_SHOW_RAW_JSON:-}" = "1" ]; then
  printf '\033[1;36m--- Raw JSON response ---\033[0m\n'
  printf '%s\n' "$out" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$out"
  printf '\n'
fi

if echo "$chat_text" | grep -qi "PONG"; then
  ok "assistant text contains PONG (see above)"
  exit 0
fi

die "expected PONG in assistant text (parsed block above); raw (first 800 chars): ${out:0:800}"
