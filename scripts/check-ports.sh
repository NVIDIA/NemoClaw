#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# check-ports.sh — Check whether NemoClaw ports are available.
#
# Reads configured ports from .env (if present), falls back to defaults.
# Pass custom ports as arguments to check additional ports.
#
# Usage:
#   scripts/check-ports.sh            # check configured/default ports
#   scripts/check-ports.sh 9000 9080  # check custom ports

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Load .env ────────────────────────────────────────────────────────
load_env() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"        # strip comments
    line="${line#"${line%%[![:space:]]*}"}"  # trim leading whitespace
    line="${line%"${line##*[![:space:]]}"}"  # trim trailing whitespace
    [[ -z "$line" ]] && continue
    [[ "$line" == *=* ]] || continue
    local key="${line%%=*}"
    local val="${line#*=}"
    # Strip surrounding quotes
    val="${val#\"}" ; val="${val%\"}"
    val="${val#\'}" ; val="${val%\'}"
    # Only set if not already in environment
    if [[ -z "${!key+x}" ]]; then
      export "$key=$val"
    fi
  done < "$env_file"
}

load_env "$PROJECT_ROOT/.env.local"
load_env "$PROJECT_ROOT/.env"

# ── Resolve ports ────────────────────────────────────────────────────
DASHBOARD_PORT="${NEMOCLAW_DASHBOARD_PORT:-${DASHBOARD_PORT:-${PUBLIC_PORT:-18789}}}"
GATEWAY_PORT="${NEMOCLAW_GATEWAY_PORT:-8080}"
VLLM_PORT="${NEMOCLAW_VLLM_PORT:-8000}"
OLLAMA_PORT="${NEMOCLAW_OLLAMA_PORT:-11434}"

# ── Validate ports ──────────────────────────────────────────────────
validate_port() {
  local name="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "Error: $name is not a valid integer: '$value'" >&2
    exit 1
  fi
  if (( value < 1024 || value > 65535 )); then
    echo "Error: $name=$value is out of range (must be 1024–65535)" >&2
    exit 1
  fi
}

validate_port "DASHBOARD_PORT" "$DASHBOARD_PORT"
validate_port "GATEWAY_PORT" "$GATEWAY_PORT"
validate_port "VLLM_PORT" "$VLLM_PORT"
validate_port "OLLAMA_PORT" "$OLLAMA_PORT"

# ── Ensure lsof is available ────────────────────────────────────────
if ! command -v lsof >/dev/null 2>&1; then
  echo "Error: lsof is required but not found in PATH" >&2
  exit 1
fi

# ── Check a single port ─────────────────────────────────────────────
conflicts=0

check_port() {
  local port="$1"
  local label="${2:-}"
  local prefix="$port"
  [[ -n "$label" ]] && prefix="$port ($label)"

  if lsof -iTCP:"$port" -sTCP:LISTEN -nP >/dev/null 2>&1; then
    local proc
    proc="$(lsof -iTCP:"$port" -sTCP:LISTEN -nP 2>/dev/null | awk 'NR==2 {print $1 " (PID " $2 ")"}')"
    echo "  CONFLICT  $prefix — in use by $proc"
    conflicts=$((conflicts + 1))
    return 1
  else
    echo "  ok        $prefix"
    return 0
  fi
}

# ── Run checks ───────────────────────────────────────────────────────
echo "Checking NemoClaw ports..."
echo ""

check_port "$DASHBOARD_PORT" "dashboard" || true
check_port "$GATEWAY_PORT" "gateway" || true
check_port "$VLLM_PORT" "vllm/nim" || true
check_port "$OLLAMA_PORT" "ollama" || true

if [[ $# -gt 0 ]]; then
  echo ""
  echo "Custom ports:"
  for p in "$@"; do
    check_port "$p" || true
  done
fi

echo ""
if [[ $conflicts -gt 0 ]]; then
  echo "$conflicts port conflict(s) found."
  echo "Set NEMOCLAW_*_PORT env vars or edit .env to use different ports."
  exit 1
else
  echo "All ports available."
fi
