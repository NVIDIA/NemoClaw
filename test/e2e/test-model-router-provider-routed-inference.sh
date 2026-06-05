#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Coverage guard for #3255 — Model Router (Provider Routed) onboard must
# produce a working inference.local route instead of HTTP 503.

set -uo pipefail

PASS=0
FAIL=0
TOTAL=0

pass() {
  ((PASS++))
  ((TOTAL++))
  echo "  OK: $1"
}
fail() {
  ((FAIL++))
  ((TOTAL++))
  echo "  ERROR: $1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

is_routed_pong_response() {
  local raw="$1"
  python3 - "$raw" <<'PY'
import json, re, sys
raw = sys.argv[1]
try:
    data = json.loads(raw)
except Exception:
    raise SystemExit(1)
model = str(data.get("model", ""))
choices = data.get("choices") or []
content = ""
if choices and isinstance(choices[0], dict):
    message = choices[0].get("message") or {}
    content = str(message.get("content", ""))
ok_model = model == "nvidia-routed" or model.startswith("nvidia-routed")
ok_content = re.search(r"\bPONG\b", content, re.IGNORECASE) is not None
raise SystemExit(0 if ok_model and ok_content else 1)
PY
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-model-router}"
ONBOARD_LOG="${E2E_MODEL_ROUTER_ONBOARD_LOG:-/tmp/nemoclaw-e2e-model-router-onboard.log}"
RESPONSE_LOG="${E2E_MODEL_ROUTER_RESPONSE_LOG:-/tmp/nemoclaw-e2e-model-router-response.log}"
HEALTH_LOG="${E2E_MODEL_ROUTER_HEALTH_LOG:-/tmp/nemoclaw-e2e-model-router-health.log}"
TIMEOUT_CMD="${TIMEOUT_CMD:-timeout}"

# shellcheck source=test/e2e/lib/install-path-refresh.sh
. "${SCRIPT_DIR}/lib/install-path-refresh.sh"
# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "${SCRIPT_DIR}/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

redact_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  python3 - "$file" <<'PY'
import os, sys
path = sys.argv[1]
secrets = [os.environ.get("NVIDIA_API_KEY", ""), os.environ.get("NEMOCLAW_PROVIDER_KEY", "")]
text = open(path, "r", errors="replace").read()
for secret in filter(None, secrets):
    text = text.replace(secret, "<REDACTED>")
open(path, "w").write(text)
PY
}

# shellcheck disable=SC2329 # Invoked indirectly by the EXIT trap.
cleanup() {
  local rc=$?
  redact_file "$ONBOARD_LOG"
  redact_file "$RESPONSE_LOG"
  redact_file "$HEALTH_LOG"
  if [ "${NEMOCLAW_E2E_KEEP_SANDBOX:-0}" != "1" ]; then
    nemoclaw "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT # invoked by EXIT trap

section "Prerequisites"
if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running"
  exit 1
fi

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set"
else
  fail "NVIDIA_API_KEY is required and must start with nvapi-"
  exit 1
fi

section "Install NemoClaw from checkout"
if ! command -v nemoclaw >/dev/null 2>&1; then
  NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    bash "${REPO}/install.sh" --non-interactive --yes-i-accept-third-party-software >"$ONBOARD_LOG" 2>&1 || true
  nemoclaw_refresh_install_env
fi

if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw is available: $(nemoclaw --version 2>/dev/null || echo unknown)"
else
  fail "nemoclaw not found after install"
  exit 1
fi

section "Onboard with Model Router provider"
rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
nemoclaw "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1 || true

env \
  NEMOCLAW_PROVIDER_KEY="$NVIDIA_API_KEY" \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_POLICY_TIER="open" \
  NEMOCLAW_PROVIDER="routed" \
  NVIDIA_API_KEY="$NVIDIA_API_KEY" \
  "$TIMEOUT_CMD" 1500 nemoclaw onboard --fresh --non-interactive --yes-i-accept-third-party-software \
  >"$ONBOARD_LOG" 2>&1
onboard_rc=$?
redact_file "$ONBOARD_LOG"
if [ "$onboard_rc" -eq 0 ]; then
  pass "Model Router onboard completed"
else
  fail "Model Router onboard failed (exit ${onboard_rc}); see ${ONBOARD_LOG}"
  exit 1
fi

section "Host model-router health"
health=""
for _ in $(seq 1 20); do
  health="$(curl -s --max-time 10 http://127.0.0.1:4000/health 2>&1 || true)"
  printf '%s\n' "$health" >"$HEALTH_LOG"
  redact_file "$HEALTH_LOG"
  if echo "$health" | grep -Eq '"healthy_count"[[:space:]]*:[[:space:]]*[1-9]'; then
    pass "model-router reports at least one healthy endpoint"
    break
  fi
  sleep 3
done
if ! echo "$health" | grep -Eq '"healthy_count"[[:space:]]*:[[:space:]]*[1-9]'; then
  fail "model-router has no healthy endpoints; expected #3255 main-equivalent failure"
  info "Health excerpt: $(head -c 500 "$HEALTH_LOG")"
  exit 1
fi

section "Sandbox inference.local routed completion"
response=""
for _ in $(seq 1 3); do
  response="$(openshell sandbox exec --name "$SANDBOX_NAME" -- \
    curl -sk --max-time 90 https://inference.local/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{"model":"nvidia-routed","messages":[{"role":"user","content":"Reply with exactly one word: PONG"}],"max_tokens":50}' \
    2>&1 || true)"
  printf '%s\n' "$response" >"$RESPONSE_LOG"
  redact_file "$RESPONSE_LOG"
  if is_routed_pong_response "$response"; then
    pass "inference.local returned a routed Model Router completion"
    break
  fi
  if echo "$response" | grep -qi 'inference service unavailable\|HTTP 503\|healthy_count.*0'; then
    break
  fi
  sleep 5
done

if is_routed_pong_response "$response"; then
  :
else
  fail "Model Router inference.local did not return a routed completion; expected #3255 main-equivalent failure"
  info "Response excerpt: $(head -c 500 "$RESPONSE_LOG")"
  exit 1
fi

section "Summary"
if [ "$FAIL" -eq 0 ]; then
  pass "Model Router provider-routed inference guard passed"
  exit 0
fi
exit 1
