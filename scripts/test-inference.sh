#!/usr/bin/env bash
# Test inference.local routing through OpenShell provider
set -euo pipefail

MODEL="${NEMOCLAW_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
REQ_FILE="$(mktemp /tmp/nemoclaw-inference-req.XXXXXX.json)"
trap 'rm -f "$REQ_FILE"' EXIT

echo "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"say hello\"}]}" > "$REQ_FILE"

response=$(curl -sf https://inference.local/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d @"$REQ_FILE") || {
  echo "error: inference request failed (is the sandbox running?)" >&2
  exit 1
}

echo "$response"
