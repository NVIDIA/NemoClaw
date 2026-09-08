#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

receipt=/run/secrets/nemoclaw-mcporter-audit-receipt
raw_report=/run/secrets/nemoclaw-mcporter-audit-raw-report
receipt_sha256="${NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256:-}"
seed=/run/nemoclaw-mcporter-audit-cache/reviewed-npm-audit

if [[ -e "$receipt" || -L "$receipt" || -e "$raw_report" || -L "$raw_report" || -n "$receipt_sha256" ]]; then
  [[ -f "$receipt" && ! -L "$receipt" && -f "$raw_report" && ! -L "$raw_report" && -n "$receipt_sha256" ]] || {
    echo "ERROR: cached mcporter audit requires paired receipt, raw report, and receipt SHA-256" >&2
    exit 1
  }
elif [[ -e "$seed" || -L "$seed" ]]; then
  echo "ERROR: build-context mcporter audit evidence is not trusted" >&2
  exit 1
else
  exec node --experimental-strip-types /scripts/lib/reviewed-npm-audit.mts \
    --directory /usr/local/lib/nemoclaw/mcporter-runtime \
    --exceptions /scripts/npm-audit-exceptions.json --graph mcporter-runtime --threshold high
fi

printf '%s' "$receipt_sha256" | grep -qxE '[0-9a-f]{64}' || {
  echo "ERROR: cached mcporter audit receipt SHA-256 is invalid" >&2
  exit 1
}
printf '%s  %s\n' "$receipt_sha256" "$receipt" | sha256sum --check --status - || {
  echo "ERROR: cached mcporter audit receipt hash does not match" >&2
  exit 1
}
exec node --experimental-strip-types /scripts/lib/npm-audit-receipt.mts \
  --receipt "$receipt" \
  --package-json /usr/local/lib/nemoclaw/mcporter-runtime/package.json --package-lock /usr/local/lib/nemoclaw/mcporter-runtime/package-lock.json \
  --raw-report "$raw_report" --exceptions /scripts/npm-audit-exceptions.json \
  --graph mcporter-runtime --audit-config /scripts/reviewed-npm-audit.json \
  --registry https://registry.yarnpkg.com --threshold high --legacy-npmjs true
