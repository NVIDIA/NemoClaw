# shellcheck shell=bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Handles the ownership choice when Station Express finds an existing vLLM.
# The installer owns the Express receipt and state helpers called below; this
# module owns only vLLM discovery, prompt text, and the selected handoff.

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
  # shellcheck disable=SC2034
  FORCE_STATION_INSTALL=""
  # shellcheck disable=SC2034
  STATION_DEEPSEEK=""
  info "Continuing with advanced manual Local vLLM setup. The existing workload remains unchanged."
}

handle_station_vllm_conflict() {
  local requested_model running_model choice
  requested_model="${NEMOCLAW_MODEL:-${NEMOCLAW_VLLM_MODEL:-unknown}}"
  if ! validate_station_express_resume_model "$requested_model"; then
    requested_model="${NEMOCLAW_VLLM_MODEL:-unknown}"
  fi
  running_model="$(station_existing_vllm_model 2>/dev/null || true)"
  running_model="${running_model:-unknown}"

  warn "Existing vLLM detected: ${running_model}"
  printf '  Express model: %s\n\n' "$requested_model"
  if ! express_prompt_can_read_tty; then
    warn "No interactive terminal is available. Keeping the Express setup and leaving the workload and host unchanged."
    print_station_express_stop_and_resume
    exit 12
  fi

  printf '  1. Keep Express with %s (default)\n' "$requested_model"
  if [[ "$running_model" == "unknown" ]]; then
    printf '  2. Use existing vLLM (advanced manual setup)\n'
  else
    printf '  2. Use existing vLLM with %s (advanced manual setup)\n' "$running_model"
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
