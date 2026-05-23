#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Helpers for expected-failure E2E flows.

e2e_negative_output_has_stack_trace() {
  local output="$1"
  printf '%s\n' "${output}" | grep -Eq '(^|[[:space:]])(TypeError|ReferenceError|SyntaxError):|^[[:space:]]+at '
}

e2e_negative_assert_failure() {
  local log_file="$1"
  local actual_exit="$2"
  local expected_exit="$3"
  local message_contains="$4"
  local no_stack_trace="${5:-0}"

  if [[ "${actual_exit}" -ne "${expected_exit}" ]]; then
    echo "expected failure exit ${expected_exit}, got ${actual_exit}" >&2
    cat "${log_file}" >&2
    return 1
  fi
  if [[ -n "${message_contains}" ]] && ! grep -Fq "${message_contains}" "${log_file}"; then
    echo "expected failure output to contain: ${message_contains}" >&2
    cat "${log_file}" >&2
    return 1
  fi
  if [[ "${no_stack_trace}" == "1" ]] && e2e_negative_output_has_stack_trace "$(cat "${log_file}")"; then
    echo "expected failure output not to contain a JavaScript stack trace" >&2
    cat "${log_file}" >&2
    return 1
  fi
}
