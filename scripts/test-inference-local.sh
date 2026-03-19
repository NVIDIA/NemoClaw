#!/usr/bin/env bash
# Test inference.local routing through OpenShell provider (local vLLM)
set -euo pipefail

MODEL="${NEMOCLAW_MODEL:-nvidia/nemotron-3-nano-30b-a3b}"
REQ_FILE="$(mktemp /tmp/nemoclaw-inference-req.XXXXXX.json)"
trap 'rm -f "$REQ_FILE"' EXIT

echo "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"say hello\"}]}" > "$REQ_FILE"

response=$(curl -sf https://inference.local/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d @"$REQ_FILE") || {
  echo "error: inference request failed (is the local vLLM instance running?)" >&2
  exit 1
}

echo "$response"
