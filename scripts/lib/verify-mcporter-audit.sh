#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

secret_root="${NEMOCLAW_MCPORTER_AUDIT_SECRET_ROOT:-/run/secrets}"
seed_root="${NEMOCLAW_MCPORTER_AUDIT_SEED_ROOT:-/run/nemoclaw-mcporter-audit-cache}"
secret_receipt="$secret_root/nemoclaw-mcporter-audit-receipt"
secret_raw_report="$secret_root/nemoclaw-mcporter-audit-raw-report"
seed_audit="$seed_root/reviewed-npm-audit"
receipt=""
raw_report=""
receipt_sha256=""

if [[ -e "$secret_receipt" || -L "$secret_receipt" || -e "$secret_raw_report" || -L "$secret_raw_report" || -n "${NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256:-}" ]]; then
  if [[ ! -f "$secret_receipt" || -L "$secret_receipt" || ! -f "$secret_raw_report" || -L "$secret_raw_report" ]] \
    || ! printf '%s' "$NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256" | grep -qxE '[0-9a-f]{64}'; then
    echo "ERROR: cached mcporter audit requires paired receipt, raw report, and receipt SHA-256" >&2
    exit 1
  fi
  receipt="$secret_receipt"
  raw_report="$secret_raw_report"
  receipt_sha256="$NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256"
elif [[ -e "$seed_audit" || -L "$seed_audit" ]]; then
  [[ -d "$seed_audit" && ! -L "$seed_audit" &&
    -f "$seed_audit/mcporter-runtime.receipt.json" && ! -L "$seed_audit/mcporter-runtime.receipt.json" &&
    -f "$seed_audit/mcporter-runtime.raw.json" && ! -L "$seed_audit/mcporter-runtime.raw.json" &&
    -f "$seed_audit/mcporter-runtime.receipt.sha256" && ! -L "$seed_audit/mcporter-runtime.receipt.sha256" ]] \
    || {
      echo "ERROR: seed-cached mcporter audit evidence is incomplete" >&2
      exit 1
    }
  receipt="$seed_audit/mcporter-runtime.receipt.json"
  raw_report="$seed_audit/mcporter-runtime.raw.json"
  read -r receipt_sha256 <"$seed_audit/mcporter-runtime.receipt.sha256"
  printf '%s' "$receipt_sha256" | grep -qxE '[0-9a-f]{64}' || {
    echo "ERROR: seed-cached mcporter audit receipt SHA-256 is invalid" >&2
    exit 1
  }
fi

if [[ -z "$receipt" ]]; then
  exec node --experimental-strip-types /scripts/lib/reviewed-npm-audit.mts \
    --directory /usr/local/lib/nemoclaw/mcporter-runtime \
    --exceptions /scripts/npm-audit-exceptions.json --graph mcporter-runtime --threshold high
fi

printf '%s  %s\n' "$receipt_sha256" "$receipt" | sha256sum --check --status - || {
  echo "ERROR: cached mcporter audit receipt hash does not match" >&2
  exit 1
}
exec node --experimental-strip-types /scripts/lib/npm-audit-receipt.mts \
  --receipt "$receipt" \
  --package-json /usr/local/lib/nemoclaw/mcporter-runtime/package.json \
  --package-lock /usr/local/lib/nemoclaw/mcporter-runtime/package-lock.json \
  --raw-report "$raw_report" --exceptions /scripts/npm-audit-exceptions.json \
  --graph mcporter-runtime --audit-config /scripts/reviewed-npm-audit.json \
  --registry https://registry.yarnpkg.com --threshold high --legacy-npmjs true
