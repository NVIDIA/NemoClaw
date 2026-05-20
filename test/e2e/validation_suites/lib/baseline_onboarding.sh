#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

baseline_onboarding_pass() { printf 'PASS: %s %s\n' "$1" "${2:-}"; }
baseline_onboarding_fail() {
  printf 'FAIL: %s %s\n' "$1" "${2:-}" >&2
  return 1
}

baseline_onboarding_load_context() {
  local context_file="${E2E_CONTEXT_DIR:?E2E_CONTEXT_DIR is required}/context.env"
  # shellcheck disable=SC1090
  source "$context_file"
  : "${E2E_SANDBOX_NAME:?E2E_SANDBOX_NAME is required}"
  : "${E2E_PROVIDER:?E2E_PROVIDER is required}"
  : "${E2E_INFERENCE_ROUTE:?E2E_INFERENCE_ROUTE is required}"
}

baseline_assert_nemoclaw_on_path() {
  if command -v nemoclaw >/dev/null 2>&1; then
    baseline_onboarding_pass validation.baseline_onboarding.nemoclaw_on_path "nemoclaw found"
  else
    baseline_onboarding_fail validation.baseline_onboarding.nemoclaw_on_path "nemoclaw not on PATH"
  fi
}

baseline_assert_openshell_on_path() {
  if command -v openshell >/dev/null 2>&1; then
    baseline_onboarding_pass validation.baseline_onboarding.openshell_on_path "openshell found"
  else
    baseline_onboarding_fail validation.baseline_onboarding.openshell_on_path "openshell not on PATH"
  fi
}

baseline_assert_nemoclaw_help_exits_zero() {
  local out
  if out=$(nemoclaw --help 2>&1); then
    baseline_onboarding_pass validation.baseline_onboarding.nemoclaw_help_exits_zero "nemoclaw --help exits 0"
  else
    baseline_onboarding_fail validation.baseline_onboarding.nemoclaw_help_exits_zero "nemoclaw --help failed: ${out:0:200}"
  fi
}

baseline_assert_sandbox_list_contains_context_sandbox() {
  local out
  if out=$(nemoclaw list 2>&1) && awk -v n="$E2E_SANDBOX_NAME" '$1 == n { found = 1 } END { exit !found }' <<<"$out"; then
    baseline_onboarding_pass validation.baseline_onboarding.sandbox_listed "$E2E_SANDBOX_NAME listed"
  else
    baseline_onboarding_fail validation.baseline_onboarding.sandbox_listed "sandbox not listed: ${out:0:200}"
  fi
}

baseline_assert_sandbox_status_exits_zero() {
  local out
  if out=$(nemoclaw status "$E2E_SANDBOX_NAME" 2>&1); then
    baseline_onboarding_pass validation.baseline_onboarding.sandbox_status "$E2E_SANDBOX_NAME status ok"
  else
    baseline_onboarding_fail validation.baseline_onboarding.sandbox_status "status failed: ${out:0:200}"
  fi
}

baseline_assert_logs_produce_output() {
  local out
  if out=$(nemoclaw logs "$E2E_SANDBOX_NAME" 2>&1) && [[ -n "$out" ]]; then
    baseline_onboarding_pass validation.baseline_onboarding.logs_available "logs available"
  else
    baseline_onboarding_fail validation.baseline_onboarding.logs_available "logs unavailable"
  fi
}

baseline_assert_inference_route_provider() {
  local expected="${1:-$E2E_PROVIDER}"
  if [[ "${E2E_PROVIDER:-}" == "$expected" ]]; then
    baseline_onboarding_pass validation.baseline_onboarding.inference_route_provider "provider=$expected route=${E2E_INFERENCE_ROUTE:-}"
  else
    baseline_onboarding_fail validation.baseline_onboarding.inference_route_provider "provider mismatch"
  fi
}
