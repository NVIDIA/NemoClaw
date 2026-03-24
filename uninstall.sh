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

# ---------------------------------------------------------------------------
# Color / style — disabled when NO_COLOR is set or stdout is not a TTY.
# Uses exact NVIDIA green #76B900 on truecolor terminals; 256-color otherwise.
# ---------------------------------------------------------------------------
if [[ -z "${NO_COLOR:-}" && -t 1 ]]; then
  if [[ "${COLORTERM:-}" == "truecolor" || "${COLORTERM:-}" == "24bit" ]]; then
    C_GREEN=$'\033[38;2;118;185;0m'   # #76B900 — exact NVIDIA green
  else
    C_GREEN=$'\033[38;5;148m'          # closest 256-color on dark backgrounds
  fi
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[1;31m'
  C_YELLOW=$'\033[1;33m'
  C_RESET=$'\033[0m'
else
  C_GREEN='' C_BOLD='' C_DIM='' C_RED='' C_YELLOW='' C_RESET=''
fi

info() { printf "${C_GREEN}[uninstall]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_YELLOW}[uninstall]${C_RESET} %s\n" "$*"; }
fail() { printf "${C_RED}[uninstall]${C_RESET} %s\n" "$*" >&2; exit 1; }
ok()   { printf "  ${C_GREEN}✓${C_RESET}  %s\n" "$*"; }

# spin "label" cmd [args...]  — spinner wrapper, same as installer.
spin() {
  local msg="$1"; shift

  if [[ ! -t 1 ]]; then
    info "$msg"
    "$@"
    return
  fi

  local log; log=$(mktemp)
  "$@" >"$log" 2>&1 &
  local pid=$! i=0
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')

  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${C_GREEN}%s${C_RESET}  %s" "${frames[$((i++ % 10))]}" "$msg"
    sleep 0.08
  done

  wait "$pid"; local status=$?
  if [[ $status -eq 0 ]]; then
    printf "\r  ${C_GREEN}✓${C_RESET}  %s\n" "$msg"
  else
    printf "\r  ${C_RED}✗${C_RESET}  %s\n\n" "$msg"
    cat "$log" >&2
    printf "\n"
  fi
  rm -f "$log"
  return $status
}

UNINSTALL_TOTAL_STEPS=6

# step N "Description"
step() {
  local n=$1 msg=$2
  printf "\n${C_GREEN}[%s/%s]${C_RESET} ${C_BOLD}%s${C_RESET}\n" \
    "$n" "$UNINSTALL_TOTAL_STEPS" "$msg"
  printf "  ${C_DIM}──────────────────────────────────────────────────${C_RESET}\n"
}

print_banner() {
  printf "\n"
  printf "  ${C_GREEN}${C_BOLD} ███╗   ██╗███████╗███╗   ███╗ ██████╗  ██████╗██╗      █████╗ ██╗    ██╗${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ████╗  ██║██╔════╝████╗ ████║██╔═══██╗██╔════╝██║     ██╔══██╗██║    ██║${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ██╔██╗ ██║█████╗  ██╔████╔██║██║   ██║██║     ██║     ███████║██║ █╗ ██║${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ██║╚██╗██║██╔══╝  ██║╚██╔╝██║██║   ██║██║     ██║     ██╔══██║██║███╗██║${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ██║ ╚████║███████╗██║ ╚═╝ ██║╚██████╔╝╚██████╗███████╗██║  ██║╚███╔███╔╝${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ╚═╝  ╚═══╝╚══════╝╚═╝     ╚═╝ ╚═════╝  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝${C_RESET}\n"
  printf "\n"
  printf "  ${C_DIM}Uninstaller — This will remove all NemoClaw resources.${C_RESET}\n"
  printf "  ${C_DIM}Docker, Node.js, Ollama, and npm are preserved.${C_RESET}\n"
  printf "\n"
}

print_bye() {
  printf "\n"
  printf "  ${C_GREEN}${C_BOLD}NemoClaw${C_RESET}\n"
  printf "\n"
  printf "  ${C_GREEN}${C_BOLD}Claws retracted.${C_RESET}  ${C_DIM}Until next time.${C_RESET}\n"
  printf "\n"
  printf "  ${C_DIM}https://www.nvidia.com/nemoclaw${C_RESET}\n"
  printf "\n"
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NEMOCLAW_STATE_DIR="${HOME}/.nemoclaw"
OPENSHELL_CONFIG_DIR="${HOME}/.config/openshell"
NEMOCLAW_CONFIG_DIR="${HOME}/.config/nemoclaw"
DEFAULT_GATEWAY="nemoclaw"
PROVIDERS=("nvidia-nim" "vllm-local" "ollama-local" "nvidia-ncp" "nim-local")
OPEN_SHELL_INSTALL_PATHS=("/usr/local/bin/openshell" "${XDG_BIN_HOME:-$HOME/.local/bin}/openshell")
OLLAMA_MODELS=("nemotron-3-super:120b" "nemotron-3-nano:30b")
TMP_ROOT="${TMPDIR:-/tmp}"
NEMOCLAW_SHIM_DIR="${HOME}/.local/bin"

ASSUME_YES=false
KEEP_OPEN_SHELL=false
DELETE_MODELS=false

usage() {
  printf "\n"
  printf "  ${C_BOLD}NemoClaw Uninstaller${C_RESET}\n\n"
  printf "  ${C_DIM}Usage:${C_RESET}\n"
  printf "    ./uninstall.sh [--yes] [--keep-openshell] [--delete-models]\n\n"
  printf "  ${C_GREEN}Options:${C_RESET}\n"
  printf "    --yes             Skip the confirmation prompt\n"
  printf "    --keep-openshell  Leave the openshell binary installed\n"
  printf "    --delete-models   Remove NemoClaw-pulled Ollama models\n"
  printf "    -h, --help        Show this help\n"
  printf "\n"
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

  printf "\n"
  printf "  ${C_YELLOW}What will be removed:${C_RESET}\n"
  printf "  ${C_DIM}  · All OpenShell sandboxes, gateway, and NemoClaw providers${C_RESET}\n"
  printf "  ${C_DIM}  · Related Docker containers, images, and volumes${C_RESET}\n"
  printf "  ${C_DIM}  · ~/.nemoclaw  ~/.config/openshell  ~/.config/nemoclaw${C_RESET}\n"
  printf "  ${C_DIM}  · Global nemoclaw npm package${C_RESET}\n"
  if [ "$DELETE_MODELS" = true ]; then
    printf "  ${C_DIM}  · Ollama models: %s${C_RESET}\n" "${OLLAMA_MODELS[*]}"
  else
    printf "  ${C_DIM}  · Ollama models: ${C_RESET}${C_GREEN}kept${C_RESET}${C_DIM} (pass --delete-models to remove)${C_RESET}\n"
  fi
  printf "\n"
  printf "  ${C_DIM}Docker, Node.js, npm, and Ollama are not touched.${C_RESET}\n"
  printf "\n"
  printf "  ${C_BOLD}Continue?${C_RESET} [y/N] "
  local reply=""
  if [ -t 2 ] && read -r reply 0</dev/tty 2>/dev/null; then
    :
  else
    read -r reply || true
  fi
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
  elif [ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] || [ ! -t 0 ]; then
    warn "Skipping privileged removal of $path in non-interactive mode."
    return 0
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
    if npm uninstall -g --loglevel=error nemoclaw > /dev/null 2>&1; then
      info "Removed global nemoclaw npm package"
    else
      warn "Global nemoclaw npm package not found or already removed"
    fi
  else
    warn "npm not found; skipping nemoclaw npm uninstall."
  fi

  if [ -L "${NEMOCLAW_SHIM_DIR}/nemoclaw" ] || [ -f "${NEMOCLAW_SHIM_DIR}/nemoclaw" ]; then
    remove_path "${NEMOCLAW_SHIM_DIR}/nemoclaw"
  fi
}

remove_docker_resources() {
  remove_related_docker_containers
  remove_related_docker_images
  remove_related_docker_volumes
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

gateway_volume_candidates() {
  local gateway_name="${1:-$DEFAULT_GATEWAY}"

  printf 'openshell-cluster-%s\n' "$gateway_name"
}

remove_related_docker_volumes() {
  if ! command -v docker > /dev/null 2>&1; then
    warn "docker not found; skipping Docker volume cleanup."
    return 0
  fi

  if ! docker info > /dev/null 2>&1; then
    warn "docker is not running; skipping Docker volume cleanup."
    return 0
  fi

  local -a volume_names=()
  local volume_name
  while IFS= read -r volume_name; do
    [ -n "$volume_name" ] || continue
    volume_names+=("$volume_name")
  done < <(gateway_volume_candidates "$DEFAULT_GATEWAY")

  if [ "${#volume_names[@]}" -eq 0 ]; then
    info "No NemoClaw/OpenShell Docker volumes found"
    return 0
  fi

  local removed_any=false
  for volume_name in "${volume_names[@]}"; do
    if docker volume inspect "$volume_name" > /dev/null 2>&1; then
      if docker volume rm -f "$volume_name" > /dev/null 2>&1; then
        info "Removed Docker volume $volume_name"
        removed_any=true
      else
        warn "Failed to remove Docker volume $volume_name"
      fi
    fi
  done

  if [ "$removed_any" = false ]; then
    info "No NemoClaw/OpenShell Docker volumes found"
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
  print_banner
  confirm

  step 1 "Stopping services"
  stop_helper_services
  stop_openshell_forward_processes

  step 2 "OpenShell resources"
  remove_openshell_resources

  step 3 "NemoClaw CLI"
  spin "Removing NemoClaw CLI..." remove_nemoclaw_cli

  step 4 "Docker resources"
  spin "Removing Docker resources..." remove_docker_resources

  step 5 "Ollama models"
  remove_optional_ollama_models

  step 6 "State and binaries"
  remove_runtime_temp_artifacts
  remove_openshell_binary
  remove_nemoclaw_state

  print_bye
}

if [ "${BASH_SOURCE[0]-}" = "$0" ] || { [ -z "${BASH_SOURCE[0]-}" ] && { [ "$0" = "bash" ] || [ "$0" = "-bash" ]; }; }; then
  main "$@"
fi
