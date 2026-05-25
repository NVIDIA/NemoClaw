#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# E2E test for runtime config overrides (NEMOCLAW_MODEL_OVERRIDE, CORS, etc.).
# Builds the sandbox image once, then runs each override scenario as a short-lived
# container. Each test starts the entrypoint, reads the patched openclaw.json,
# and verifies the expected field changed while other fields are untouched.
#
# Designed for parallel CI execution — no shared state between tests.
#
# Requires: docker, jq
# Usage:    bash test/e2e/test-runtime-overrides.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE="${NEMOCLAW_TEST_IMAGE:-nemoclaw-override-test}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
  echo -e "${GREEN}PASS${NC}: $1"
  PASSED=$((PASSED + 1))
}
fail() {
  echo -e "${RED}FAIL${NC}: $1"
  FAILED=$((FAILED + 1))
}
info() { echo -e "${YELLOW}TEST${NC}: $1"; }

PASSED=0
FAILED=0

# ── Log file for CI artifact collection ──────────────────────────
# Create a timestamped log file whose name matches the CI artifact glob
# test-runtime-overrides-*.log so Docker stderr is captured automatically.
LOG_DIR="${REPO_DIR}"
LOG_FILE="${LOG_DIR}/test-runtime-overrides-$(date +%Y%m%dT%H%M%S).log"
: >"$LOG_FILE"
info "Logging Docker stderr to: $LOG_FILE"

# Helper: run entrypoint with env vars, then read a config field via jq.
# The entrypoint patches config and starts the gateway — we only need the
# config patch, so we override CMD to just cat the config and exit.
# Docker stderr is captured to the log file for CI artifact visibility.
run_override() {
  local env_args=("$@")
  docker run --rm "${env_args[@]}" "$IMAGE" \
    bash -c 'cat /sandbox/.openclaw/openclaw.json; printf "\n"' 2>>"$LOG_FILE"
}

# Helper: run entrypoint with env vars and capture stderr for validation messages.
run_override_stderr() {
  local env_args=("$@")
  local tmpfile
  tmpfile="$(mktemp)"
  docker run --rm "${env_args[@]}" "$IMAGE" \
    bash -c 'true' >/dev/null 2>"$tmpfile" || true
  cat "$tmpfile"
  # Also append to the main log file for CI artifact capture
  cat "$tmpfile" >>"$LOG_FILE"
  rm -f "$tmpfile"
}

# ── Build the image ──────────────────────────────────────────────

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  info "Using pre-built image: $IMAGE"
else
  info "Building test image: $IMAGE"
  docker build -t "$IMAGE" -f "$REPO_DIR/Dockerfile" "$REPO_DIR" \
    --build-arg NEMOCLAW_DISABLE_DEVICE_AUTH=1 \
    --build-arg "NEMOCLAW_BUILD_ID=$(date +%s)" \
    --quiet
fi

# ── Capture baseline config ──────────────────────────────────────

info "Capturing baseline config (no overrides)"
if ! BASELINE=$(run_override); then
  fail "baseline container failed before config capture"
  info "Docker stderr tail:"
  tail -80 "$LOG_FILE" || true
  exit 1
fi
BASELINE_MODEL=$(echo "$BASELINE" | jq -r '.agents.defaults.model.primary')
BASELINE_CTX=$(echo "$BASELINE" | jq -r '.models.providers | to_entries[0].value.models[0].contextWindow')
BASELINE_MAX=$(echo "$BASELINE" | jq -r '.models.providers | to_entries[0].value.models[0].maxTokens')
BASELINE_REASONING=$(echo "$BASELINE" | jq -r '.models.providers | to_entries[0].value.models[0].reasoning')
BASELINE_ORIGINS=$(echo "$BASELINE" | jq -r '.gateway.controlUi.allowedOrigins | length')

info "Baseline: model=$BASELINE_MODEL ctx=$BASELINE_CTX max=$BASELINE_MAX reasoning=$BASELINE_REASONING origins=$BASELINE_ORIGINS"

# ── Test 1: No-op baseline ───────────────────────────────────────

info "1. No overrides — config matches build-time defaults"
HASH_CHECK=$(docker run --rm "$IMAGE" bash -c 'cd /sandbox/.openclaw && sha256sum -c .config-hash --status && echo OK || echo FAIL' 2>>"$LOG_FILE")
if [ "$HASH_CHECK" = "OK" ]; then
  pass "baseline config hash valid"
else
  fail "baseline config hash invalid"
fi

# ── Test 2: Model override ───────────────────────────────────────

info "2. NEMOCLAW_MODEL_OVERRIDE patches model"
OVERRIDE_MODEL="anthropic/claude-sonnet-4-6"
CFG=$(run_override -e "NEMOCLAW_MODEL_OVERRIDE=$OVERRIDE_MODEL")
ACTUAL=$(echo "$CFG" | jq -r '.agents.defaults.model.primary')
if [ "$ACTUAL" = "$OVERRIDE_MODEL" ]; then
  pass "model overridden to $OVERRIDE_MODEL"
else
  fail "expected model=$OVERRIDE_MODEL, got $ACTUAL"
fi

# Verify hash was recomputed
HASH_CHECK=$(docker run --rm -e "NEMOCLAW_MODEL_OVERRIDE=$OVERRIDE_MODEL" "$IMAGE" \
  bash -c 'cd /sandbox/.openclaw && sha256sum -c .config-hash --status && echo OK || echo FAIL' 2>>"$LOG_FILE")
if [ "$HASH_CHECK" = "OK" ]; then
  pass "config hash valid after model override"
else
  fail "config hash invalid after model override"
fi

# ── Test 3: Context window override ──────────────────────────────
# NEMOCLAW_CONTEXT_WINDOW only takes effect alongside a model override
# (standalone values are baked at build time). Ref: #2653 Phase 2.

info "3. NEMOCLAW_CONTEXT_WINDOW patches contextWindow (with model override)"
CFG=$(run_override -e "NEMOCLAW_MODEL_OVERRIDE=$OVERRIDE_MODEL" -e "NEMOCLAW_CONTEXT_WINDOW=32768")
ACTUAL=$(echo "$CFG" | jq -r '.models.providers | to_entries[0].value.models[0].contextWindow')
if [ "$ACTUAL" = "32768" ]; then
  pass "contextWindow overridden to 32768"
else
  fail "expected contextWindow=32768, got $ACTUAL"
fi

# ── Test 4: Max tokens override ──────────────────────────────────

info "4. NEMOCLAW_MAX_TOKENS patches maxTokens (with model override)"
CFG=$(run_override -e "NEMOCLAW_MODEL_OVERRIDE=$OVERRIDE_MODEL" -e "NEMOCLAW_MAX_TOKENS=16384")
ACTUAL=$(echo "$CFG" | jq -r '.models.providers | to_entries[0].value.models[0].maxTokens')
if [ "$ACTUAL" = "16384" ]; then
  pass "maxTokens overridden to 16384"
else
  fail "expected maxTokens=16384, got $ACTUAL"
fi

# ── Test 5: Reasoning override ───────────────────────────────────

info "5. NEMOCLAW_REASONING=true patches reasoning (with model override)"
CFG=$(run_override -e "NEMOCLAW_MODEL_OVERRIDE=$OVERRIDE_MODEL" -e "NEMOCLAW_REASONING=true")
ACTUAL=$(echo "$CFG" | jq -r '.models.providers | to_entries[0].value.models[0].reasoning')
if [ "$ACTUAL" = "true" ]; then
  pass "reasoning overridden to true"
else
  fail "expected reasoning=true, got $ACTUAL"
fi

# ── Test 6: CORS origin override ─────────────────────────────────

info "6. NEMOCLAW_CORS_ORIGIN adds to allowedOrigins"
CORS="https://custom.example.com:9999"
CFG=$(run_override -e "NEMOCLAW_CORS_ORIGIN=$CORS")
HAS_ORIGIN=$(echo "$CFG" | jq --arg o "$CORS" '.gateway.controlUi.allowedOrigins | index($o) != null')
NEW_LEN=$(echo "$CFG" | jq '.gateway.controlUi.allowedOrigins | length')
if [ "$HAS_ORIGIN" = "true" ] && [ "$NEW_LEN" -gt "$BASELINE_ORIGINS" ]; then
  pass "CORS origin added: $CORS"
else
  ORIGINS=$(echo "$CFG" | jq -c '.gateway.controlUi.allowedOrigins // []' 2>/dev/null || printf '%s' "$CFG")
  fail "CORS origin not found in allowedOrigins: ${ORIGINS}"
fi

# ── Test 7: Combined overrides ───────────────────────────────────

info "7. Multiple overrides applied together"
CFG=$(run_override \
  -e "NEMOCLAW_MODEL_OVERRIDE=nvidia/llama-3.3-nemotron-super-49b-v1.5" \
  -e "NEMOCLAW_CONTEXT_WINDOW=65536" \
  -e "NEMOCLAW_MAX_TOKENS=8192" \
  -e "NEMOCLAW_REASONING=true" \
  -e "NEMOCLAW_CORS_ORIGIN=https://multi.example.com")
M=$(echo "$CFG" | jq -r '.agents.defaults.model.primary')
C=$(echo "$CFG" | jq -r '.models.providers | to_entries[0].value.models[0].contextWindow')
T=$(echo "$CFG" | jq -r '.models.providers | to_entries[0].value.models[0].maxTokens')
R=$(echo "$CFG" | jq -r '.models.providers | to_entries[0].value.models[0].reasoning')
O=$(echo "$CFG" | jq --arg o "https://multi.example.com" '.gateway.controlUi.allowedOrigins | index($o) != null')
if [ "$M" = "nvidia/llama-3.3-nemotron-super-49b-v1.5" ] \
  && [ "$C" = "65536" ] && [ "$T" = "8192" ] \
  && [ "$R" = "true" ] && [ "$O" = "true" ]; then
  pass "all 5 overrides applied correctly"
else
  fail "combined override mismatch: model=$M ctx=$C max=$T reasoning=$R cors=$O"
fi

# ── Test 8-12: Validation rejections ─────────────────────────────

info "8. NEMOCLAW_MODEL_OVERRIDE with control chars is rejected"
STDERR=$(run_override_stderr -e $'NEMOCLAW_MODEL_OVERRIDE=bad\x01model')
if echo "$STDERR" | grep -q "control characters"; then
  pass "model override with control chars rejected"
else
  fail "model override with control chars was not rejected"
fi

info "9. NEMOCLAW_CONTEXT_WINDOW with non-integer is rejected"
STDERR=$(run_override_stderr -e "NEMOCLAW_MODEL_OVERRIDE=test" -e "NEMOCLAW_CONTEXT_WINDOW=notanumber")
if echo "$STDERR" | grep -q "must be a positive integer"; then
  pass "non-integer context window rejected"
else
  fail "non-integer context window was not rejected"
fi

info "10. NEMOCLAW_MAX_TOKENS with non-integer is rejected"
STDERR=$(run_override_stderr -e "NEMOCLAW_MODEL_OVERRIDE=test" -e "NEMOCLAW_MAX_TOKENS=abc")
if echo "$STDERR" | grep -q "must be a positive integer"; then
  pass "non-integer max tokens rejected"
else
  fail "non-integer max tokens was not rejected"
fi

info "11. NEMOCLAW_REASONING with invalid value is rejected"
STDERR=$(run_override_stderr -e "NEMOCLAW_MODEL_OVERRIDE=test" -e "NEMOCLAW_REASONING=maybe")
if echo "$STDERR" | grep -q 'must be "true" or "false"'; then
  pass "invalid reasoning value rejected"
else
  fail "invalid reasoning value was not rejected"
fi

info "12. NEMOCLAW_CORS_ORIGIN without http/https is rejected"
STDERR=$(run_override_stderr -e "NEMOCLAW_CORS_ORIGIN=ftp://evil.com")
if echo "$STDERR" | grep -q "must start with http"; then
  pass "non-http CORS origin rejected"
else
  fail "non-http CORS origin was not rejected"
fi

info "13. NEMOCLAW_INFERENCE_API_OVERRIDE with invalid type is rejected"
STDERR=$(run_override_stderr -e "NEMOCLAW_MODEL_OVERRIDE=test" -e "NEMOCLAW_INFERENCE_API_OVERRIDE=graphql")
if echo "$STDERR" | grep -q "openai-completions"; then
  pass "invalid inference API type rejected"
else
  fail "invalid inference API type was not rejected"
fi

# ── Test 14: Original config unchanged after rejected override ───

info "14. Config unchanged after rejected override"
CFG=$(run_override -e "NEMOCLAW_MODEL_OVERRIDE=test" -e "NEMOCLAW_CONTEXT_WINDOW=notanumber")
ACTUAL_CTX=$(echo "$CFG" | jq -r '.models.providers | to_entries[0].value.models[0].contextWindow')
ACTUAL_MODEL=$(echo "$CFG" | jq -r '.agents.defaults.model.primary')
if [ "$ACTUAL_CTX" = "$BASELINE_CTX" ] && [ "$ACTUAL_MODEL" = "$BASELINE_MODEL" ]; then
  pass "config unchanged after rejected override"
else
  fail "config was modified despite rejected override: model=$ACTUAL_MODEL ctx=$ACTUAL_CTX (expected model=$BASELINE_MODEL ctx=$BASELINE_CTX)"
fi

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo "────────────────────────────────────────────────"
echo -e "Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
echo "────────────────────────────────────────────────"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
