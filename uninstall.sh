#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw uninstaller.
# Removes the host-side resources created by the installer/setup flow:
#   - NemoClaw helper services
#   - All OpenShell sandboxes plus the NemoClaw gateway/providers
#   - NemoClaw/OpenShell/OpenClaw Docker images built or pulled for the sandbox flow
#   - ~/.nemoclaw plus ~/.config/{openshell,nemoclaw} state
#   - Global nemoclaw npm install/link
#   - OpenShell binary if it was installed to the standard installer path
#
# Preserves shared system tooling such as Docker, Node.js, npm, and Ollama by default.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${GREEN}[uninstall]${NC} $1"; }
warn() { echo -e "${YELLOW}[uninstall]${NC} $1"; }
fail() { echo -e "${RED}[uninstall]${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NEMOCLAW_STATE_DIR="${HOME}/.nemoclaw"
OPENSHELL_CONFIG_DIR="${HOME}/.config/openshell"
NEMOCLAW_CONFIG_DIR="${HOME}/.config/nemoclaw"
DEFAULT_GATEWAY="nemoclaw"
PROVIDERS=("nvidia-nim" "vllm-local" "ollama-local" "nvidia-ncp" "nim-local")
OPEN_SHELL_INSTALL_PATHS=("/usr/local/bin/openshell")
OLLAMA_MODELS=("nemotron-3-super:120b" "nemotron-3-nano:30b")
TMP_ROOT="${TMPDIR:-/tmp}"

ASSUME_YES=false
KEEP_OPEN_SHELL=false
DELETE_MODELS=false

usage() {
  cat <<'EOF'
Usage: ./uninstall.sh [--yes] [--keep-openshell] [--delete-models]

Options:
  --yes             Skip the confirmation prompt
  --keep-openshell  Leave the openshell binary installed
  --delete-models   Remove NemoClaw-pulled Ollama models
  -h, --help        Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --yes)
      ASSUME_YES=true
      shift
      ;;
    --keep-openshell)
      KEEP_OPEN_SHELL=true
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

confirm() {
  if [ "$ASSUME_YES" = true ]; then
    return 0
  fi

  echo ""
  warn "This will remove all OpenShell sandboxes, NemoClaw-managed gateway/providers,"
  warn "related Docker images, and local state under ~/.nemoclaw, ~/.config/openshell,"
  warn "and ~/.config/nemoclaw."
  warn "It will not uninstall Docker, Ollama, npm, Node.js, or other shared tooling."
  if [ "$DELETE_MODELS" = false ]; then
    warn "Ollama models are preserved by default. Re-run with --delete-models to remove them."
  fi
  printf "Continue? [y/N] "
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) info "Aborted."; exit 0 ;;
  esac
}

run_optional() {
  local description="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    info "$description"
  else
    warn "$description skipped"
  fi
}

remove_path() {
  local path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    rm -rf "$path"
    info "Removed $path"
  fi
}

remove_glob_paths() {
  local pattern="$1"
  local path
  for path in $pattern; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    rm -rf "$path"
    info "Removed $path"
  done
}

remove_file_with_optional_sudo() {
  local path="$1"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return 0
  fi

  if [ -w "$path" ] || [ -w "$(dirname "$path")" ]; then
    rm -f "$path"
  else
    sudo rm -f "$path"
  fi
  info "Removed $path"
}

stop_helper_services() {
  if [ -x "$SCRIPT_DIR/scripts/start-services.sh" ]; then
    run_optional "Stopped NemoClaw helper services" "$SCRIPT_DIR/scripts/start-services.sh" --stop
  fi

  remove_glob_paths "${TMP_ROOT}/nemoclaw-services-*"
}

stop_openshell_forward_processes() {
  if ! command -v pgrep > /dev/null 2>&1; then
    warn "pgrep not found; skipping local OpenShell forward process cleanup."
    return 0
  fi

  local -a pids=()
  local pid
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    pids+=("$pid")
  done < <(pgrep -f 'openshell.*forward.*18789' 2>/dev/null || true)

  if [ "${#pids[@]}" -eq 0 ]; then
    info "No local OpenShell forward processes found"
    return 0
  fi

  for pid in "${pids[@]}"; do
    if kill "$pid" > /dev/null 2>&1 || kill -9 "$pid" > /dev/null 2>&1; then
      info "Stopped OpenShell forward process $pid"
    else
      warn "Failed to stop OpenShell forward process $pid"
    fi
  done
}

remove_openshell_resources() {
  if ! command -v openshell > /dev/null 2>&1; then
    warn "openshell not found; skipping gateway/provider/sandbox cleanup."
    return 0
  fi

  run_optional "Deleted all OpenShell sandboxes" openshell sandbox delete --all

  for provider in "${PROVIDERS[@]}"; do
    run_optional "Deleted provider '${provider}'" openshell provider delete "$provider"
  done

  run_optional "Destroyed gateway '${DEFAULT_GATEWAY}'" openshell gateway destroy -g "$DEFAULT_GATEWAY"
}

remove_nemoclaw_cli() {
  if command -v npm > /dev/null 2>&1; then
    npm unlink -g nemoclaw > /dev/null 2>&1 || true
    if npm uninstall -g nemoclaw > /dev/null 2>&1; then
      info "Removed global nemoclaw npm package"
    else
      warn "Global nemoclaw npm package not found or already removed"
    fi
  else
    warn "npm not found; skipping nemoclaw npm uninstall."
  fi
}

remove_nemoclaw_state() {
  remove_path "$NEMOCLAW_STATE_DIR"
  remove_path "$OPENSHELL_CONFIG_DIR"
  remove_path "$NEMOCLAW_CONFIG_DIR"
}

remove_related_docker_containers() {
  if ! command -v docker > /dev/null 2>&1; then
    warn "docker not found; skipping Docker container cleanup."
    return 0
  fi

  if ! docker info > /dev/null 2>&1; then
    warn "docker is not running; skipping Docker container cleanup."
    return 0
  fi

  local -a container_ids=()
  local line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    container_ids+=("$line")
  done < <(
    docker ps -a --format '{{.ID}} {{.Image}} {{.Names}}' 2>/dev/null \
      | awk '
          BEGIN { IGNORECASE=1 }
          {
            ref=$0
            if (ref ~ /openshell-cluster/ || ref ~ /openshell/ || ref ~ /openclaw/ || ref ~ /nemoclaw/) {
              print $1
            }
          }
        ' \
      | awk '!seen[$0]++'
  )

  if [ "${#container_ids[@]}" -eq 0 ]; then
    info "No NemoClaw/OpenShell Docker containers found"
    return 0
  fi

  local removed_any=false
  local container_id
  for container_id in "${container_ids[@]}"; do
    if docker rm -f "$container_id" > /dev/null 2>&1; then
      info "Removed Docker container $container_id"
      removed_any=true
    else
      warn "Failed to remove Docker container $container_id"
    fi
  done

  if [ "$removed_any" = false ]; then
    warn "No related Docker containers were removed"
  fi
}

remove_related_docker_images() {
  if ! command -v docker > /dev/null 2>&1; then
    warn "docker not found; skipping Docker image cleanup."
    return 0
  fi

  if ! docker info > /dev/null 2>&1; then
    warn "docker is not running; skipping Docker image cleanup."
    return 0
  fi

  local -a image_ids=()
  local line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    image_ids+=("$line")
  done < <(
    docker images --format '{{.ID}} {{.Repository}}:{{.Tag}}' 2>/dev/null \
      | awk '
          BEGIN { IGNORECASE=1 }
          {
            ref=$0
            if (ref ~ /openshell/ || ref ~ /openclaw/ || ref ~ /nemoclaw/) {
              print $1
            }
          }
        ' \
      | awk '!seen[$0]++'
  )

  if [ "${#image_ids[@]}" -eq 0 ]; then
    info "No NemoClaw/OpenShell Docker images found"
    return 0
  fi

  local removed_any=false
  local image_id
  for image_id in "${image_ids[@]}"; do
    if docker rmi -f "$image_id" > /dev/null 2>&1; then
      info "Removed Docker image $image_id"
      removed_any=true
    else
      warn "Failed to remove Docker image $image_id"
    fi
  done

  if [ "$removed_any" = false ]; then
    warn "No related Docker images were removed"
  fi
}

remove_optional_ollama_models() {
  if [ "$DELETE_MODELS" != true ]; then
    info "Keeping Ollama models as requested."
    return 0
  fi

  if ! command -v ollama > /dev/null 2>&1; then
    warn "ollama not found; skipping model cleanup."
    return 0
  fi

  local model
  for model in "${OLLAMA_MODELS[@]}"; do
    if ollama rm "$model" > /dev/null 2>&1; then
      info "Removed Ollama model '$model'"
    else
      warn "Ollama model '$model' not found or already removed"
    fi
  done
}

remove_runtime_temp_artifacts() {
  remove_glob_paths "${TMP_ROOT}/nemoclaw-create-*.log"
  remove_glob_paths "${TMP_ROOT}/nemoclaw-tg-ssh-*.conf"
}

remove_openshell_binary() {
  if [ "$KEEP_OPEN_SHELL" = true ]; then
    info "Keeping openshell binary as requested."
    return 0
  fi

  local removed=false
  local current_path=""
  if command -v openshell > /dev/null 2>&1; then
    current_path="$(command -v openshell)"
  fi

  for path in "${OPEN_SHELL_INSTALL_PATHS[@]}"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      remove_file_with_optional_sudo "$path"
      removed=true
    fi
  done

  if [ "$removed" = false ] && [ -n "$current_path" ]; then
    warn "openshell is installed at $current_path; leaving it in place."
  elif [ "$removed" = false ]; then
    warn "openshell binary not found in installer-managed locations."
  fi
}

main() {
  confirm

  info "Stopping NemoClaw helper services..."
  stop_helper_services

  info "Stopping local OpenShell forward processes..."
  stop_openshell_forward_processes

  info "Removing OpenShell resources created for NemoClaw..."
  remove_openshell_resources

  info "Removing global nemoclaw install..."
  remove_nemoclaw_cli

  info "Removing NemoClaw state..."
  remove_nemoclaw_state

  info "Removing related Docker containers..."
  remove_related_docker_containers

  info "Removing related Docker images..."
  remove_related_docker_images

  info "Removing optional Ollama models..."
  remove_optional_ollama_models

  info "Removing runtime temp artifacts..."
  remove_runtime_temp_artifacts

  info "Removing openshell binary..."
  remove_openshell_binary

  echo ""
  info "Uninstall complete."
}

main "$@"
