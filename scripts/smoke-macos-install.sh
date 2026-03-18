#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Run the primary NemoClaw install flow on a local machine, capture logs,
# then uninstall and verify cleanup. Intended for manual smoke validation.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${GREEN}[smoke]${NC} $1"; }
warn() { echo -e "${YELLOW}[smoke]${NC} $1"; }
fail() { echo -e "${RED}[smoke]${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SANDBOX_NAME="smoke-$(date +%Y%m%d%H%M%S)"
LOG_DIR="${TMPDIR:-/tmp}/nemoclaw-smoke"
ALLOW_EXISTING_STATE=false
KEEP_LOGS=false
KEEP_OPEN_SHELL=true
DELETE_MODELS=false

INSTALL_LOG=""
UNINSTALL_LOG=""
INSTALL_STATUS=1
UNINSTALL_STATUS=1

usage() {
  cat <<'EOF'
Usage: ./scripts/smoke-macos-install.sh [options]

Options:
  --sandbox-name <name>       Sandbox name to feed into install.sh
  --log-dir <dir>             Directory for install/uninstall logs
  --allow-existing-state      Allow running even if NemoClaw/OpenShell state already exists
  --keep-logs                 Preserve log files after success
  --remove-openshell          Allow uninstall.sh to remove openshell
  --delete-models             Allow uninstall.sh to delete Ollama models
  -h, --help                  Show this help

Environment:
  NVIDIA_API_KEY              Required for the cloud install path
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --sandbox-name)
      SANDBOX_NAME="${2:-}"
      [ -n "$SANDBOX_NAME" ] || fail "--sandbox-name requires a value"
      shift 2
      ;;
    --log-dir)
      LOG_DIR="${2:-}"
      [ -n "$LOG_DIR" ] || fail "--log-dir requires a value"
      shift 2
      ;;
    --allow-existing-state)
      ALLOW_EXISTING_STATE=true
      shift
      ;;
    --keep-logs)
      KEEP_LOGS=true
      shift
      ;;
    --remove-openshell)
      KEEP_OPEN_SHELL=false
      shift
      ;;
    --delete-models)
      DELETE_MODELS=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY must be set for the smoke install flow."
[ -x "$REPO_DIR/install.sh" ] || fail "install.sh not found at repo root."
[ -x "$REPO_DIR/uninstall.sh" ] || fail "uninstall.sh not found at repo root."

validate_sandbox_name() {
  if ! [[ "$SANDBOX_NAME" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
    fail "Invalid sandbox name '$SANDBOX_NAME'. Use lowercase letters, numbers, and hyphens."
  fi
}

ensure_clean_start() {
  if [ "$ALLOW_EXISTING_STATE" = true ]; then
    return 0
  fi

  if [ -d "$HOME/.nemoclaw" ] || [ -d "$HOME/.config/nemoclaw" ] || [ -d "$HOME/.config/openshell" ]; then
    fail "Existing NemoClaw/OpenShell state detected. Re-run with --allow-existing-state if you really want to test on this machine."
  fi

  if command -v openshell > /dev/null 2>&1; then
    if openshell sandbox list 2>/dev/null | grep -Eq '[[:alnum:]]'; then
      fail "Existing OpenShell sandboxes detected. Re-run with --allow-existing-state only if you are prepared for uninstall.sh to remove them."
    fi
  fi
}

write_answers_file() {
  local answers_file="$1"
  cat > "$answers_file" <<EOF
$SANDBOX_NAME

n
EOF
}

run_install() {
  local answers_file="$1"
  info "Running install.sh with sandbox '$SANDBOX_NAME'"
  set +e
  bash "$REPO_DIR/install.sh" < "$answers_file" > >(tee "$INSTALL_LOG") 2>&1
  INSTALL_STATUS=$?
  set -e
  return 0
}

run_uninstall() {
  local -a args=(--yes)
  if [ "$KEEP_OPEN_SHELL" = true ]; then
    args+=(--keep-openshell)
  fi
  if [ "$DELETE_MODELS" = true ]; then
    args+=(--delete-models)
  fi

  info "Running uninstall.sh for cleanup"
  set +e
  bash "$REPO_DIR/uninstall.sh" "${args[@]}" > >(tee "$UNINSTALL_LOG") 2>&1
  UNINSTALL_STATUS=$?
  set -e
  return 0
}

verify_cleanup() {
  local leftovers=0

  if [ -d "$HOME/.nemoclaw" ] || [ -d "$HOME/.config/nemoclaw" ]; then
    warn "NemoClaw state directories still exist under HOME."
    leftovers=1
  fi

  if command -v openshell > /dev/null 2>&1; then
    local sandbox_output
    sandbox_output="$(openshell sandbox list 2>/dev/null || true)"
    if printf '%s' "$sandbox_output" | grep -Eq '[[:alnum:]]'; then
      warn "OpenShell still reports sandbox entries after uninstall."
      leftovers=1
    fi
  fi

  if command -v docker > /dev/null 2>&1 && docker info > /dev/null 2>&1; then
    local related_containers
    related_containers="$(
      docker ps -a --format '{{.Image}} {{.Names}}' 2>/dev/null \
        | awk 'BEGIN { IGNORECASE=1 } /openshell-cluster|openshell|openclaw|nemoclaw/ { print }'
    )"
    if [ -n "$related_containers" ]; then
      warn "Related Docker containers remain after uninstall:"
      printf '%s\n' "$related_containers"
      leftovers=1
    fi
  fi

  return "$leftovers"
}

cleanup() {
  if [ -n "$UNINSTALL_LOG" ]; then
    run_uninstall
    if [ "$UNINSTALL_STATUS" -ne 0 ]; then
      warn "uninstall.sh exited with status $UNINSTALL_STATUS"
    fi
    if ! verify_cleanup; then
      warn "Cleanup verification found leftover state."
    else
      info "Cleanup verification passed"
    fi
  fi

  if [ "$KEEP_LOGS" = false ] && [ "$INSTALL_STATUS" -eq 0 ] && [ "$UNINSTALL_STATUS" -eq 0 ]; then
    rm -f "$INSTALL_LOG" "$UNINSTALL_LOG"
    rmdir "$LOG_DIR" 2>/dev/null || true
  else
    info "Install log: $INSTALL_LOG"
    info "Uninstall log: $UNINSTALL_LOG"
  fi
}

main() {
  validate_sandbox_name
  ensure_clean_start

  mkdir -p "$LOG_DIR"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  INSTALL_LOG="$LOG_DIR/install-$stamp.log"
  UNINSTALL_LOG="$LOG_DIR/uninstall-$stamp.log"

  local answers_file
  answers_file="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-smoke-answers-XXXXXX")"
  trap 'rm -f "$answers_file"; cleanup' EXIT
  write_answers_file "$answers_file"

  info "Logs will be written under $LOG_DIR"
  run_install "$answers_file"

  if [ "$INSTALL_STATUS" -ne 0 ]; then
    fail "install.sh failed with status $INSTALL_STATUS. See $INSTALL_LOG"
  fi

  info "install.sh completed successfully"
}

main "$@"
