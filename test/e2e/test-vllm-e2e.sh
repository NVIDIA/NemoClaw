#!/bin/bash
# vLLM E2E: start vLLM container -> health check -> inference -> cleanup
#
# Proves that vLLM can serve inference on a local GPU. Runs a small model
# (meta/llama-3.1-8b-instruct or equivalent) in a vLLM container and sends
# a chat completion request.
#
# Prerequisites:
#   - Docker running with GPU support (--gpus all)
#   - NVIDIA GPU with >=16GB VRAM
#   - Network access to pull vLLM image (first run only)
#
# Usage:
#   bash test/e2e/test-vllm-e2e.sh
#
# See: https://github.com/NVIDIA/NemoClaw/issues/71

set -uo pipefail

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() { ((PASS++)); ((TOTAL++)); printf '\033[32m  PASS: %s\033[0m\n' "$1"; }
fail() { ((FAIL++)); ((TOTAL++)); printf '\033[31m  FAIL: %s\033[0m\n' "$1"; }
skip() { ((SKIP++)); ((TOTAL++)); printf '\033[33m  SKIP: %s\033[0m\n' "$1"; }
section() { echo ""; printf '\033[1;36m=== %s ===\033[0m\n' "$1"; }
info()  { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

CONTAINER_NAME="nemoclaw-vllm-e2e"
VLLM_PORT=8099
MODEL="facebook/opt-125m"  # Tiny model for fast E2E testing (~250MB)

# ======================================================================
# Phase 0: Pre-cleanup
# ======================================================================
section "Phase 0: Pre-cleanup"
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
pass "Pre-cleanup complete"

# ======================================================================
# Phase 1: Prerequisites
# ======================================================================
section "Phase 1: Prerequisites"

if docker info > /dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running"
  exit 1
fi

if nvidia-smi > /dev/null 2>&1; then
  GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
  if [ "${GPU_MEM:-0}" -ge 16000 ]; then
    pass "GPU detected with ${GPU_MEM} MB VRAM"
  else
    skip "GPU VRAM (${GPU_MEM:-0} MB) below 16GB minimum — skipping"
    exit 0
  fi
else
  skip "No NVIDIA GPU detected — skipping vLLM E2E"
  exit 0
fi

# ======================================================================
# Phase 2: Start vLLM container
# ======================================================================
section "Phase 2: Start vLLM container"

info "Starting vLLM with model ${MODEL} on port ${VLLM_PORT}..."
CONTAINER_OUTPUT=$(docker run -d \
  --gpus all \
  --name "$CONTAINER_NAME" \
  -p "${VLLM_PORT}:8000" \
  --shm-size 4g \
  vllm/vllm-openai:latest \
  --model "$MODEL" \
  --max-model-len 512 \
  --dtype float16 2>&1)
CONTAINER_RC=$?
CONTAINER_ID=$(echo "$CONTAINER_OUTPUT" | tail -1)

[ $CONTAINER_RC -eq 0 ] \
  && pass "vLLM container started" \
  || { fail "Failed to start vLLM container"; exit 1; }

# ======================================================================
# Phase 3: Wait for health
# ======================================================================
section "Phase 3: Wait for health"

info "Waiting for vLLM to load model (up to 120s)..."
HEALTHY=false
for i in $(seq 1 24); do
  if curl -sf "http://localhost:${VLLM_PORT}/v1/models" > /dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 5
done

if [ "$HEALTHY" = true ]; then
  pass "vLLM is healthy on port ${VLLM_PORT}"
else
  fail "vLLM did not become healthy within 120s"
  docker logs "$CONTAINER_NAME" 2>&1 | tail -20
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  exit 1
fi

# ======================================================================
# Phase 4: Inference test
# ======================================================================
section "Phase 4: Inference test"

info "Sending chat completion request..."
RESPONSE=$(curl -s --max-time 30 \
  -X POST "http://localhost:${VLLM_PORT}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Say hello\"}],
    \"max_tokens\": 50
  }" 2>/dev/null) || true

if [ -n "$RESPONSE" ]; then
  # Check for valid response structure
  HAS_CHOICES=$(echo "$RESPONSE" | python3 -c "
import json, sys
try:
    r = json.load(sys.stdin)
    print('yes' if 'choices' in r and len(r['choices']) > 0 else 'no')
except:
    print('no')
" 2>/dev/null) || true

  if [ "$HAS_CHOICES" = "yes" ]; then
    pass "vLLM inference returned valid response"
  else
    fail "vLLM response missing choices: ${RESPONSE:0:200}"
  fi
else
  fail "vLLM inference returned empty response"
fi

# ======================================================================
# Phase 5: Cleanup
# ======================================================================
section "Phase 5: Cleanup"

docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
pass "Container cleaned up"

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "========================================"
echo "  vLLM E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  vLLM E2E PASSED\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
