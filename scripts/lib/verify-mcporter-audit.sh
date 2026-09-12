#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

receipt=/run/secrets/nemoclaw-mcporter-audit-receipt
raw_report=/run/secrets/nemoclaw-mcporter-audit-raw-report
policy_result=/run/secrets/nemoclaw-mcporter-audit-policy-result
receipt_sha256="${NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256:-}"
policy_result_sha256="${NEMOCLAW_MCPORTER_AUDIT_POLICY_RESULT_SHA256:-}"
seed=/run/nemoclaw-mcporter-audit-cache/reviewed-npm-audit
report_path="${NEMOCLAW_MCPORTER_AUDIT_REPORT_PATH:-}"
result_path="${NEMOCLAW_MCPORTER_AUDIT_RESULT_PATH:-}"
audit_output_args=()
[[ -z "$report_path" ]] || audit_output_args+=(--report "$report_path")
[[ -z "$result_path" ]] || audit_output_args+=(--result "$result_path")

if [[ -e "$receipt" || -L "$receipt" || -e "$raw_report" || -L "$raw_report" || -e "$policy_result" || -L "$policy_result" || -n "$receipt_sha256" || -n "$policy_result_sha256" ]]; then
  [[ -f "$receipt" && ! -L "$receipt" && -f "$raw_report" && ! -L "$raw_report" && -f "$policy_result" && ! -L "$policy_result" && -n "$receipt_sha256" && -n "$policy_result_sha256" ]] || {
    echo "ERROR: cached mcporter audit requires paired receipt, raw report, trusted policy result, and transport SHA-256 values" >&2
    exit 1
  }
elif [[ -e "$seed" || -L "$seed" ]]; then
  echo "ERROR: build-context mcporter audit evidence is not trusted" >&2
  exit 1
else
  node /scripts/lib/reviewed-npm-audit.mts \
    --directory /usr/local/lib/nemoclaw/mcporter-runtime \
    --exceptions /scripts/npm-audit-exceptions.json --graph mcporter-runtime --threshold high \
    "${audit_output_args[@]}"
  exit
fi

printf '%s' "$receipt_sha256" | grep -qxE '[0-9a-f]{64}' || {
  echo "ERROR: cached mcporter audit receipt SHA-256 is invalid" >&2
  exit 1
}
printf '%s  %s\n' "$receipt_sha256" "$receipt" | sha256sum --check --status - || {
  echo "ERROR: cached mcporter audit receipt hash does not match" >&2
  exit 1
}
printf '%s' "$policy_result_sha256" | grep -qxE '[0-9a-f]{64}' || {
  echo "ERROR: cached mcporter audit policy result SHA-256 is invalid" >&2
  exit 1
}
printf '%s  %s\n' "$policy_result_sha256" "$policy_result" | sha256sum --check --status - || {
  echo "ERROR: cached mcporter audit policy result hash does not match" >&2
  exit 1
}
raw_report_sha256="$(jq -er '
  .rawResponseSha256 | select(type == "string" and test("^[0-9a-f]{64}$"))
' "$receipt")" || {
  echo "ERROR: verified mcporter audit receipt does not declare a raw response SHA-256" >&2
  exit 1
}
printf '%s  %s\n' "$raw_report_sha256" "$raw_report" | sha256sum --check --status - || {
  echo "ERROR: cached mcporter audit raw report does not match the verified receipt" >&2
  exit 1
}
[[ -z "$report_path" ]] || cp -- "$raw_report" "$report_path"
[[ -z "$result_path" ]] || cp -- "$policy_result" "$result_path"
