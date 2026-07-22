# shellcheck shell=bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Handles the ownership choice and continuation when Station Express finds an
# existing vLLM. Shared installer state and receipt primitives remain in
# install.sh.

_STATION_LOCAL_VLLM_SELECTED=""

station_local_vllm_resume_file() {
  printf '%s/.nemoclaw/station-local-vllm-resume' "$HOME"
}

assert_station_local_vllm_resume_file_safe() {
  local state_file=$1 state_dir mode
  state_dir="$(dirname "$state_file")"
  assert_station_express_resume_directory_safe "$state_dir"
  [[ -f "$state_file" && ! -L "$state_file" && -O "$state_file" ]] \
    || error "DGX Station Local vLLM resume state must be a regular file owned by the current user: ${state_file}"
  mode="$(portable_file_mode "$state_file")" \
    || error "Could not inspect DGX Station Local vLLM resume state permissions: ${state_file}"
  [[ "$mode" == "600" ]] \
    || error "DGX Station Local vLLM resume state must have mode 0600: ${state_file}"
}

save_station_local_vllm_resume() {
  local state_file state_dir temp_file revision gateway_port vllm_port
  revision="$(station_installer_revision)"
  gateway_port="$(resolve_nemoclaw_gateway_port)"
  vllm_port="$(station_express_resume_port_value NEMOCLAW_VLLM_PORT 8000)"
  state_file="$(station_local_vllm_resume_file)" \
    || error "Could not resolve NemoClaw state for DGX Station Local vLLM resume."
  state_dir="$(ensure_nemoclaw_state_dir)" \
    || error "Could not prepare NemoClaw state for DGX Station Local vLLM resume."
  assert_nemoclaw_state_path_safe "$state_file"
  if [[ -e "$state_file" || -L "$state_file" ]]; then
    assert_station_local_vllm_resume_file_safe "$state_file"
  fi
  temp_file="$(mktemp "${state_file}.tmp.XXXXXX")" \
    || error "Could not create DGX Station Local vLLM resume state under ${state_dir}."
  chmod 600 "$temp_file" || {
    rm -f "$temp_file"
    error "Could not secure DGX Station Local vLLM resume state under ${state_dir}."
  }
  if ! printf 'version=1\nrevision=%s\ngateway_port=%s\nvllm_port=%s\n' \
    "$revision" "$gateway_port" "$vllm_port" >"$temp_file"; then
    rm -f "$temp_file"
    error "Could not write DGX Station Local vLLM resume state under ${state_dir}."
  fi
  if ! mv -f "$temp_file" "$state_file"; then
    rm -f "$temp_file"
    error "Could not publish DGX Station Local vLLM resume state under ${state_dir}."
  fi
  assert_station_local_vllm_resume_file_safe "$state_file"
}

clear_station_local_vllm_resume() {
  local state_file state_dir
  state_file="$(station_local_vllm_resume_file)" || return 0
  assert_nemoclaw_state_path_safe "$state_file"
  state_dir="$(dirname "$state_file")"
  [[ -e "$state_dir" || -L "$state_dir" ]] || return 0
  assert_station_express_resume_directory_safe "$state_dir"
  [[ -e "$state_file" || -L "$state_file" ]] || return 0
  assert_station_local_vllm_resume_file_safe "$state_file"
  rm -f "$state_file"
}

station_local_vllm_resume_command() {
  local revision
  revision="$(station_installer_revision)"
  printf 'curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_TAG=%q bash' "$revision"
}

activate_station_local_vllm_continuation() {
  local arg
  local -a continuation_args=()
  _STATION_LOCAL_VLLM_SELECTED=1
  export NEMOCLAW_NO_EXPRESS=1
  if declare -p _NEMOCLAW_INSTALLER_ARGS >/dev/null 2>&1; then
    for arg in "${_NEMOCLAW_INSTALLER_ARGS[@]}"; do
      case "$arg" in
        --force-station-install | --station-deepseek) ;;
        *) continuation_args+=("$arg") ;;
      esac
    done
    _NEMOCLAW_INSTALLER_ARGS=("${continuation_args[@]}")
  fi
  # These caller-owned globals are consumed later by install.sh after this
  # sourced module returns.
  # shellcheck disable=SC2034
  FORCE_STATION_INSTALL=""
  # shellcheck disable=SC2034
  STATION_DEEPSEEK=""
}

station_vllm_workload_active() {
  local processes containers
  processes="$(ps -eo pid=,ppid=,comm=,args= 2>/dev/null)" || return 2
  if awk '
    {
      comm=tolower($3)
      $1=$2=$3=""
      args=tolower($0)
      if (comm == "vllm" ||
          args ~ /(^|[[:space:]\/])vllm([[:space:]:]|\.js([[:space:]]|$)|$)/) {
        found=1
      }
    }
    END { exit found ? 0 : 1 }
  ' <<<"$processes"; then
    return 0
  fi

  command -v docker >/dev/null 2>&1 || return 2
  containers="$(docker ps --no-trunc --format '{{.Image}}|{{.Command}}' 2>/dev/null)" || return 2
  awk -F '|' '
    tolower($1 " " $2) ~ /(^|[^[:alnum:]_])vllm([^[:alnum:]_]|$)/ { found=1 }
    END { exit found ? 0 : 1 }
  ' <<<"$containers"
}

consume_station_local_vllm_resume() {
  local state_file version_line revision_line gateway_port_line vllm_port_line
  local saved_revision saved_gateway_port saved_vllm_port current_revision
  local current_gateway_port current_vllm_port line_count workload_status=0
  state_file="$(station_local_vllm_resume_file)" || return 1
  assert_nemoclaw_state_path_safe "$state_file"
  [[ -e "$state_file" || -L "$state_file" ]] || return 1
  assert_station_local_vllm_resume_file_safe "$state_file"
  line_count="$(wc -l <"$state_file" | tr -d '[:space:]')"
  version_line="$(sed -n '1p' "$state_file")"
  revision_line="$(sed -n '2p' "$state_file")"
  gateway_port_line="$(sed -n '3p' "$state_file")"
  vllm_port_line="$(sed -n '4p' "$state_file")"
  saved_revision="${revision_line#revision=}"
  saved_gateway_port="${gateway_port_line#gateway_port=}"
  saved_vllm_port="${vllm_port_line#vllm_port=}"
  if ! {
    [[ "$line_count" == "4" && "$version_line" == "version=1" &&
      "$revision_line" == "revision=${saved_revision}" &&
      "$gateway_port_line" == "gateway_port=${saved_gateway_port}" &&
      "$vllm_port_line" == "vllm_port=${saved_vllm_port}" ]] \
      && validate_station_express_resume_revision "$saved_revision" \
      && validate_station_express_resume_port "$saved_gateway_port" \
      && validate_station_express_resume_port "$saved_vllm_port"
  }; then
    error "DGX Station Local vLLM resume state is invalid. Remove ${state_file} and rerun the installer."
  fi
  current_revision="$(station_installer_revision)"
  [[ "$current_revision" == "$saved_revision" ]] \
    || error "DGX Station Local vLLM resume requires installer revision ${saved_revision}; rerun with NEMOCLAW_INSTALL_TAG=${saved_revision}."
  station_vllm_workload_active || workload_status=$?
  case "$workload_status" in
    0) ;;
    1)
      rm -f "$state_file"
      info "The saved Local vLLM workload is no longer active. Express setup is available."
      return 1
      ;;
    *)
      info "Docker access is not available yet. Preserving the selected manual Local vLLM setup."
      ;;
  esac
  if [[ -n "${NEMOCLAW_GATEWAY_PORT:-}" ]]; then
    current_gateway_port="$(resolve_nemoclaw_gateway_port)"
    [[ "$current_gateway_port" == "$saved_gateway_port" ]] \
      || error "DGX Station Local vLLM resume requires NEMOCLAW_GATEWAY_PORT=${saved_gateway_port}."
  fi
  if [[ -n "${NEMOCLAW_VLLM_PORT:-}" ]]; then
    current_vllm_port="$(station_express_resume_port_value NEMOCLAW_VLLM_PORT 8000)"
    [[ "$current_vllm_port" == "$saved_vllm_port" ]] \
      || error "DGX Station Local vLLM resume requires NEMOCLAW_VLLM_PORT=${saved_vllm_port}."
  fi
  NEMOCLAW_GATEWAY_PORT="$saved_gateway_port"
  NEMOCLAW_VLLM_PORT="$saved_vllm_port"
  export NEMOCLAW_GATEWAY_PORT NEMOCLAW_VLLM_PORT
  clear_station_express_resume
  activate_station_local_vllm_continuation
}

station_existing_vllm_model() {
  local response model port
  port="${NEMOCLAW_VLLM_PORT:-8000}"
  command -v curl >/dev/null 2>&1 || return 1
  command -v python3 >/dev/null 2>&1 || return 1
  response="$(curl -fsS --connect-timeout 1 --max-time 3 --max-filesize 1048576 \
    "http://127.0.0.1:${port}/v1/models" 2>/dev/null)" || return 1
  model="$(printf '%s' "$response" | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
models = payload.get("data") if isinstance(payload, dict) else None
if not isinstance(models, list) or not models or not isinstance(models[0], dict):
    raise SystemExit(1)
model = models[0].get("id")
if not isinstance(model, str):
    raise SystemExit(1)
sys.stdout.write(model)
' 2>/dev/null)" || return 1
  validate_station_express_resume_model "$model" || return 1
  printf '%s' "$model"
}

read_station_vllm_conflict_choice() {
  local prompt_input="/dev/tty" choice
  if [ -t 0 ]; then prompt_input="/dev/stdin"; fi
  [[ -r "$prompt_input" ]] || return 1
  IFS= read -r choice <"$prompt_input" || return 1
  printf '%s' "$choice"
}

print_station_express_stop_and_resume() {
  info "Keep Express: stop the vLLM workload with the command shown above, then resume with:"
  info "$(station_express_resume_command)"
}

switch_station_express_to_local_vllm() {
  save_station_local_vllm_resume
  clear_station_express_resume
  _SELECTED_EXPRESS_PLATFORM=""
  _STATION_EXPRESS_RESUME_LOADED=""
  _STATION_EXPRESS_RESUME_GENERATION=""
  # These caller-owned globals are consumed later by install.sh after this
  # sourced module returns.
  # shellcheck disable=SC2034
  NON_INTERACTIVE=""
  # shellcheck disable=SC2034
  NON_INTERACTIVE_SOURCE=""
  export NEMOCLAW_NON_INTERACTIVE=""
  unset NEMOCLAW_NON_INTERACTIVE_SUDO_MODE NEMOCLAW_YES NEMOCLAW_POLICY_MODE
  unset NEMOCLAW_STATION_EXPRESS NEMOCLAW_STATION_EXPRESS_RECEIPT_GENERATION
  unset NEMOCLAW_PROVIDER NEMOCLAW_MODEL NEMOCLAW_VLLM_MODEL
  activate_station_local_vllm_continuation
  info "Continuing with advanced manual Local vLLM setup. The existing workload remains unchanged."
}

handle_station_vllm_conflict() {
  local requested_model running_model choice port
  port="${NEMOCLAW_VLLM_PORT:-8000}"
  requested_model="${NEMOCLAW_MODEL:-${NEMOCLAW_VLLM_MODEL:-unknown}}"
  if ! validate_station_express_resume_model "$requested_model"; then
    requested_model="${NEMOCLAW_VLLM_MODEL:-unknown}"
  fi
  running_model="$(station_existing_vllm_model 2>/dev/null || true)"
  running_model="${running_model:-unknown}"

  warn "Existing vLLM workload detected."
  printf '  Model reported by port %s: %s\n' "$port" "$running_model"
  printf '  Express model: %s\n\n' "$requested_model"
  if ! express_prompt_can_read_tty; then
    warn "No interactive terminal is available. Keeping the Express setup and leaving the workload and host unchanged."
    print_station_express_stop_and_resume
    exit 12
  fi

  printf '  1. Keep Express with %s (default)\n' "$requested_model"
  if [[ "$running_model" == "unknown" ]]; then
    printf '  2. Use Local vLLM at port %s (advanced manual setup)\n' "$port"
  else
    printf '  2. Use Local vLLM at port %s (reported model: %s; advanced manual setup)\n' \
      "$port" "$running_model"
  fi
  while true; do
    printf '  Choose 1 or 2 [1]: '
    if ! choice="$(read_station_vllm_conflict_choice)"; then
      printf '\n'
      warn "No choice was received. Keeping the Express setup and leaving the workload and host unchanged."
      print_station_express_stop_and_resume
      exit 12
    fi
    case "$choice" in
      "" | 1)
        print_station_express_stop_and_resume
        exit 12
        ;;
      2)
        switch_station_express_to_local_vllm
        return 0
        ;;
      *) warn "Enter 1 or 2." ;;
    esac
  done
}
