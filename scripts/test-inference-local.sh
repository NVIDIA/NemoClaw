#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Test inference.local routing through OpenShell provider (local vLLM).

set -euo pipefail

REQ_FILE="$(mktemp /tmp/nemoclaw-test-req-XXXXXX.json)"
trap 'rm -f "$REQ_FILE"' EXIT

cat > "$REQ_FILE" <<'JSON'
{"model":"nvidia/nemotron-3-nano-30b-a3b","messages":[{"role":"user","content":"say hello"}]}
JSON

curl -sf --max-time 30 https://inference.local/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d @"$REQ_FILE"
echo ""
