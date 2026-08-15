#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shared retry helpers for inference-switch E2Es. These tests still verify the
# final OpenShell route, sandbox config, and live inference after this helper
# returns. Exhausting the transient retry budget remains a verified failure.

is_transient_inference_set_failure() {
  if grep -qiE 'authentication failed|authorization failed|unauthorized|forbidden|HTTP 40[13]|(^|[^0-9])40[13]([^0-9]|$)|denied by network policy|network policy denied|policy (update |validation )?failed|malformed|invalid (provider|model|configuration|request|.*(credential|api[_ -]?key))|(model|route|verification) mismatch|expected (model|provider|route).*(got|found)' <<<"$1"; then
    return 1
  fi
  grep -qiE 'timed? out|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|failed to connect|error sending request|(^|[^0-9])50[234]([^0-9]|$)' <<<"$1"
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
  if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || [ "$attempts" -gt 10 ]; then
    printf 'Invalid NEMOCLAW_SWITCH_SET_ATTEMPTS=%s; expected an integer between 1 and 10.\n' "$attempts" >&2
    return 2
  fi
  if [ "$#" -eq 0 ]; then
    printf 'run_inference_set_with_retry requires an inference set command.\n' >&2
    return 2
  fi

  local attempt rc output
  local -a command=("$@")
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    output=$("${command[@]}" 2>&1)
    rc=$?
    if [ "$rc" -eq 0 ]; then
      printf '%s\n' "$output"
      return 0
    fi

    if ! is_transient_inference_set_failure "$output" || [ "$attempt" -ge "$attempts" ]; then
      printf '%s\n' "$output"
      return "$rc"
    fi

    log_inference_switch_retry_info "Verified inference switch attempt ${attempt}/${attempts} hit a transient failure; retrying..."
    sleep $((attempt * 5))
  done

  printf 'Inference switch retry loop completed without running an attempt.\n' >&2
  return 1
}
