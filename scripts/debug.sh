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
#   curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/scripts/debug.sh | bash

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
  curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/scripts/debug.sh | bash
USAGE
      exit 0
      ;;
    *)
      warn "Unknown option: $1"
      shift
      ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────

TMPDIR_BASE="${TMPDIR:-/tmp}"
COLLECT_DIR=$(mktemp -d "${TMPDIR_BASE}/nemoclaw-debug-XXXXXX")

# Run a command, print output, and save to a file in the collect dir.
# Silently skips commands that are not found.
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

  # Run with a timeout to avoid hangs
  if timeout 30 "$@" > "$outfile" 2>&1; then
    cat "$outfile"
  else
    cat "$outfile"
    echo "  (command exited with non-zero status)"
  fi
}

# ── Auto-detect sandbox name if not given ────────────────────────

if [ -z "$SANDBOX_NAME" ]; then
  if command -v openshell &>/dev/null; then
    SANDBOX_NAME=$(openshell sandbox list 2>/dev/null | head -1 | awk '{print $1}' || true)
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
collect "free" free -m

if [ "$QUICK" = false ]; then
  collect "df" df -h
fi

# -- Processes --

section "Processes"
collect "ps-cpu" ps -eo pid,ppid,cmd,%mem,%cpu --sort=-%cpu | head -30

if [ "$QUICK" = false ]; then
  collect "ps-mem" ps -eo pid,ppid,cmd,%mem,%cpu --sort=-%mem | head -30
  collect "ps-all" ps -ef
  collect "top" top -b -n 1 | head -50
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
collect "openshell-sandbox-logs" openshell sandbox logs "$SANDBOX_NAME"

if [ "$QUICK" = false ]; then
  collect "openshell-gateway-info" openshell gateway info
fi

# -- Network (full mode only) --

if [ "$QUICK" = false ]; then
  section "Network"
  collect "ss" ss -ltnp
  collect "ip-addr" ip addr
  collect "ip-route" ip route
  collect "resolv-conf" cat /etc/resolv.conf
  collect "nslookup" nslookup integrate.api.nvidia.com
  collect "curl-models" curl -I -s https://integrate.api.nvidia.com/v1/models
  collect "lsof-net" lsof -i -P -n
  collect "lsof-18789" lsof -i :18789
fi

# -- Kernel / IO (full mode only) --

if [ "$QUICK" = false ]; then
  section "Kernel / IO"
  collect "vmstat" vmstat 1 5
  collect "iostat" iostat -xz 1 5
fi

# -- dmesg (always, last 100 lines) --

section "Kernel Messages"
collect "dmesg" dmesg | tail -100

# ── Produce tarball if requested ─────────────────────────────────

if [ -n "$OUTPUT" ]; then
  tar czf "$OUTPUT" -C "$(dirname "$COLLECT_DIR")" "$(basename "$COLLECT_DIR")"
  info "Tarball written to ${OUTPUT}"
  info "Attach this file to your GitHub issue."
fi

# ── Cleanup ──────────────────────────────────────────────────────

if [ -z "$OUTPUT" ]; then
  rm -rf "$COLLECT_DIR"
else
  info "Raw files kept in ${COLLECT_DIR}"
fi

echo ""
info "Done. If filing a bug, run with --output and attach the tarball to your issue:"
info "  nemoclaw debug --output /tmp/nemoclaw-debug.tar.gz"
