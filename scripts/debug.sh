#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Collect NemoClaw diagnostic information for bug reports.
#
# Outputs to stdout and optionally writes a tarball.
#
# Usage:
#   ./scripts/debug.sh                          # full diagnostics to stdout
#   ./scripts/debug.sh --quick                  # minimal diagnostics
#   ./scripts/debug.sh --sandbox mybox          # target a specific sandbox
#   ./scripts/debug.sh --output /tmp/diag.tar.gz  # also save tarball
#   nemoclaw debug [--quick] [--output path]    # via CLI wrapper
#
# Can also be run without cloning:
#   curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/scripts/debug.sh | bash -s -- --quick

set -euo pipefail

# ── Setup ────────────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${GREEN}[debug]${NC} $1"; }
warn()    { echo -e "${YELLOW}[debug]${NC} $1"; }
fail()    { echo -e "${RED}[debug]${NC} $1"; exit 1; }
section() { echo -e "\n${CYAN}═══ $1 ═══${NC}\n"; }

# ── Parse flags ──────────────────────────────────────────────────

SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-}}"
QUICK=false
OUTPUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --sandbox)
      SANDBOX_NAME="${2:?--sandbox requires a name}"
      shift 2
      ;;
    --quick)
      QUICK=true
      shift
      ;;
    --output|-o)
      OUTPUT="${2:?--output requires a path}"
      shift 2
      ;;
    --help|-h)
      cat <<'USAGE'
Usage: scripts/debug.sh [OPTIONS]

Collect NemoClaw diagnostic information for bug reports.

Options:
  --sandbox NAME    Target sandbox (default: $NEMOCLAW_SANDBOX or auto-detect)
  --quick           Collect minimal diagnostics only
  --output PATH     Write tarball to PATH (e.g. /tmp/nemoclaw-debug.tar.gz)
  --help            Show this help

Examples:
  nemoclaw debug
  nemoclaw debug --quick
  nemoclaw debug --output /tmp/diag.tar.gz
  curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/scripts/debug.sh | bash -s -- --quick
USAGE
      exit 0
      ;;
    *)
      fail "Unknown option: $1 (see --help)"
      ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────

TMPDIR_BASE="${TMPDIR:-/tmp}"
COLLECT_DIR=$(mktemp -d "${TMPDIR_BASE}/nemoclaw-debug-XXXXXX")
SANDBOX_SSH_CONFIG=""
cleanup() {
  rm -rf "$COLLECT_DIR"
  if [ -n "$SANDBOX_SSH_CONFIG" ]; then
    rm -f "$SANDBOX_SSH_CONFIG"
  fi
}
trap cleanup EXIT

# Platform detection
IS_MACOS=false
if [ "$(uname -s)" = "Darwin" ]; then
  IS_MACOS=true
fi

# Detect timeout binary (GNU coreutils; gtimeout on macOS via brew)
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
fi

# Redact known sensitive patterns (API keys, tokens, passwords in env/args).
redact() {
  sed -E \
    -e 's/(NVIDIA_API_KEY|API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|_KEY)=\S+/\1=<REDACTED>/gi' \
    -e 's/(nvapi-[A-Za-z0-9_-]{10,})/<REDACTED>/g' \
    -e 's/(ghp_[A-Za-z0-9]{30,})/<REDACTED>/g' \
    -e 's/(Bearer )[^ ]+/\1<REDACTED>/gi'
}

# Run a command, print output, and save to a file in the collect dir.
# Silently skips commands that are not found. Output is redacted for secrets.
collect() {
  local label="$1"
  shift
  local filename
  filename=$(echo "$label" | tr ' /' '_-')
  local outfile="${COLLECT_DIR}/${filename}.txt"

  if ! command -v "$1" &>/dev/null; then
    echo "  ($1 not found, skipping)" | tee "$outfile"
    return 0
  fi

  local rc=0
  local tmpout="${outfile}.raw"
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" 30 "$@" > "$tmpout" 2>&1 || rc=$?
  else
    "$@" > "$tmpout" 2>&1 || rc=$?
  fi

  redact < "$tmpout" > "$outfile"
  rm -f "$tmpout"

  cat "$outfile"
  if [ "$rc" -ne 0 ]; then
    echo "  (command exited with non-zero status)"
  fi
}

# ── Auto-detect sandbox name if not given ────────────────────────

if [ -z "$SANDBOX_NAME" ]; then
  if command -v openshell &>/dev/null; then
    SANDBOX_NAME=$(
      openshell sandbox list 2>/dev/null \
        | awk 'NF { if (tolower($1) == "name") next; print $1; exit }'
    ) || true
  fi
  SANDBOX_NAME="${SANDBOX_NAME:-default}"
fi

# ── Collect diagnostics ──────────────────────────────────────────

info "Collecting diagnostics for sandbox '${SANDBOX_NAME}'..."
info "Quick mode: ${QUICK}"
[ -n "$OUTPUT" ] && info "Tarball output: ${OUTPUT}"
echo ""

# -- System basics --

section "System"
collect "date" date
collect "uname" uname -a
collect "uptime" uptime
if [ "$IS_MACOS" = true ]; then
  # shellcheck disable=SC2016
  collect "memory" sh -c 'echo "Physical: $(($(sysctl -n hw.memsize) / 1048576)) MB"; vm_stat'
else
  collect "free" free -m
fi

if [ "$QUICK" = false ]; then
  collect "df" df -h
fi

# -- Processes --

section "Processes"
if [ "$IS_MACOS" = true ]; then
  collect "ps-cpu" sh -c 'ps -eo pid,ppid,comm,%mem,%cpu | sort -k5 -rn | head -30'
else
  collect "ps-cpu" sh -c 'ps -eo pid,ppid,cmd,%mem,%cpu --sort=-%cpu | head -30'
fi

if [ "$QUICK" = false ]; then
  if [ "$IS_MACOS" = true ]; then
    collect "ps-mem" sh -c 'ps -eo pid,ppid,comm,%mem,%cpu | sort -k4 -rn | head -30'
    collect "top" sh -c 'top -l 1 | head -50'
  else
    collect "ps-mem" sh -c 'ps -eo pid,ppid,cmd,%mem,%cpu --sort=-%mem | head -30'
    collect "top" sh -c 'top -b -n 1 | head -50'
  fi
fi

# -- GPU --

section "GPU"
collect "nvidia-smi" nvidia-smi

if [ "$QUICK" = false ]; then
  collect "nvidia-smi-dmon" nvidia-smi dmon -s pucvmet -c 10
  collect "nvidia-smi-query" nvidia-smi --query-gpu=name,utilization.gpu,utilization.memory,memory.total,memory.used,temperature.gpu,power.draw --format=csv
fi

# -- Docker --

section "Docker"
collect "docker-ps" docker ps -a
collect "docker-stats" docker stats --no-stream

if [ "$QUICK" = false ]; then
  collect "docker-info" docker info
  collect "docker-df" docker system df
fi

# Collect logs for NemoClaw-related containers
for cid in $(docker ps -a --filter "label=com.nvidia.nemoclaw" --format '{{.Names}}' 2>/dev/null || true); do
  collect "docker-logs-${cid}" docker logs --tail 200 "$cid"
  if [ "$QUICK" = false ]; then
    collect "docker-inspect-${cid}" docker inspect "$cid"
  fi
done

# -- OpenShell --

section "OpenShell"
collect "openshell-status" openshell status
collect "openshell-sandbox-list" openshell sandbox list
collect "openshell-sandbox-get" openshell sandbox get "$SANDBOX_NAME"
collect "openshell-logs" openshell logs "$SANDBOX_NAME"

if [ "$QUICK" = false ]; then
  collect "openshell-gateway-info" openshell gateway info
fi

# -- Sandbox internals (via SSH using openshell ssh-config) --

if command -v openshell &>/dev/null \
  && openshell sandbox list 2>/dev/null \
    | awk 'NF { if (tolower($1) == "name") next; print $1 }' \
    | grep -Fxq -- "$SANDBOX_NAME"; then
  section "Sandbox Internals"

  # Build a temporary SSH config so we can run commands inside the sandbox.
  # This follows the pattern from OpenShell's own demo.sh.
  SANDBOX_SSH_CONFIG=$(mktemp "${TMPDIR_BASE}/nemoclaw-ssh-XXXXXX")
  if openshell sandbox ssh-config "$SANDBOX_NAME" > "$SANDBOX_SSH_CONFIG" 2>/dev/null; then
    SANDBOX_SSH_HOST="openshell-${SANDBOX_NAME}"
    SANDBOX_SSH_OPTS=(-F "$SANDBOX_SSH_CONFIG" -o StrictHostKeyChecking=no -o ConnectTimeout=10)

    collect "sandbox-ps" ssh "${SANDBOX_SSH_OPTS[@]}" "$SANDBOX_SSH_HOST" ps -ef
    collect "sandbox-free" ssh "${SANDBOX_SSH_OPTS[@]}" "$SANDBOX_SSH_HOST" free -m
    if [ "$QUICK" = false ]; then
      collect "sandbox-top" ssh "${SANDBOX_SSH_OPTS[@]}" "$SANDBOX_SSH_HOST" 'top -b -n 1 | head -50'
      collect "sandbox-gateway-log" ssh "${SANDBOX_SSH_OPTS[@]}" "$SANDBOX_SSH_HOST" tail -200 /tmp/gateway.log
    fi
  else
    warn "Could not generate SSH config for sandbox '${SANDBOX_NAME}', skipping internals"
  fi
fi

# -- Network (full mode only) --

if [ "$QUICK" = false ]; then
  section "Network"
  if [ "$IS_MACOS" = true ]; then
    collect "listening" sh -c 'netstat -anp tcp | grep LISTEN'
    collect "ifconfig" ifconfig
    collect "routes" netstat -rn
    collect "dns-config" scutil --dns
  else
    collect "ss" ss -ltnp
    collect "ip-addr" ip addr
    collect "ip-route" ip route
    collect "resolv-conf" cat /etc/resolv.conf
  fi
  collect "nslookup" nslookup integrate.api.nvidia.com
  # shellcheck disable=SC2016
  collect "curl-models" sh -c 'code=$(curl -s -o /dev/null -w "%{http_code}" https://integrate.api.nvidia.com/v1/models); echo "HTTP $code"; if [ "$code" -ge 200 ] && [ "$code" -lt 500 ]; then echo "NIM API reachable"; else echo "NIM API unreachable"; exit 1; fi'
  collect "lsof-net" sh -c 'lsof -i -P -n 2>/dev/null | head -50'
  collect "lsof-18789" lsof -i :18789
fi

# -- Kernel / IO (full mode only) --

if [ "$QUICK" = false ]; then
  section "Kernel / IO"
  if [ "$IS_MACOS" = true ]; then
    collect "vmstat" vm_stat
    collect "iostat" iostat -c 5 -w 1
  else
    collect "vmstat" vmstat 1 5
    collect "iostat" iostat -xz 1 5
  fi
fi

# -- dmesg (always, last 100 lines) --

section "Kernel Messages"
if [ "$IS_MACOS" = true ]; then
  collect "system-log" sh -c 'log show --last 5m --predicate "eventType == logEvent" --style compact 2>/dev/null | tail -100'
else
  collect "dmesg" sh -c 'dmesg | tail -100'
fi

# ── Produce tarball if requested ─────────────────────────────────

if [ -n "$OUTPUT" ]; then
  tar czf "$OUTPUT" -C "$(dirname "$COLLECT_DIR")" "$(basename "$COLLECT_DIR")"
  info "Tarball written to ${OUTPUT}"
  warn "Known secrets are auto-redacted, but please review for any remaining sensitive data before sharing."
  info "Attach this file to your GitHub issue."
fi

echo ""
info "Done. If filing a bug, run with --output and attach the tarball to your issue:"
info "  nemoclaw debug --output /tmp/nemoclaw-debug.tar.gz"

