#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shared retry helpers for inference-switch E2Es. These tests still verify the
# final OpenShell route, sandbox config, and live inference after this helper
# returns. The --no-verify fallback is only used after verified route-setting
# attempts fail with transient upstream/network symptoms.

is_transient_inference_set_failure() {
  grep -qiE 'timed? out|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|502|503|504|temporar' <<<"$1"
}

log_inference_switch_retry_info() {
  if declare -F info >/dev/null 2>&1; then
    info "$1"
  else
    printf '\033[1;34m  [info]\033[0m %s\n' "$1"
  fi
}

run_inference_set_with_retry() {
  local attempts="${NEMOCLAW_SWITCH_SET_ATTEMPTS:-3}"
  if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]]; then
    printf 'Invalid NEMOCLAW_SWITCH_SET_ATTEMPTS=%s; expected a positive integer.\n' "$attempts" >&2
    return 2
  fi
  if [ "$#" -eq 0 ]; then
    printf 'run_inference_set_with_retry requires an inference set command.\n' >&2
    return 2
  fi

  local attempt rc output fallback_output
  local -a command=("$@")
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    output=$("${command[@]}" 2>&1)
    rc=$?
    if [ "$rc" -eq 0 ]; then
      printf '%s\n' "$output"
      return 0
    fi

    if ! is_transient_inference_set_failure "$output" || [ "$attempt" -ge "$attempts" ]; then
      if is_transient_inference_set_failure "$output"; then
        log_inference_switch_retry_info "Verified inference switch failed after ${attempts} transient attempt(s); retrying with --no-verify before live route checks..."
        fallback_output=$("${command[@]}" --no-verify 2>&1)
        rc=$?
        printf '%s\n%s\n' "$output" "$fallback_output"
        return "$rc"
      fi
      printf '%s\n' "$output"
      return "$rc"
    fi

    log_inference_switch_retry_info "Verified inference switch attempt ${attempt}/${attempts} hit a transient failure; retrying..."
    sleep $((attempt * 5))
  done

  printf 'Inference switch retry loop completed without running an attempt.\n' >&2
  return 1
}
