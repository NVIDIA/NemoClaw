#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

secret_root="/run/secrets"
seed_root="/run/nemoclaw-mcporter-audit-cache/reviewed-npm-audit"
secret_receipt="$secret_root/nemoclaw-mcporter-audit-receipt"
secret_raw_report="$secret_root/nemoclaw-mcporter-audit-raw-report"
receipt=""
raw_report=""
receipt_sha256="${NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256:-}"

if [[ -e "$secret_receipt" || -L "$secret_receipt" || -e "$secret_raw_report" || -L "$secret_raw_report" || -n "$receipt_sha256" ]]; then
  if [[ ! -f "$secret_receipt" || -L "$secret_receipt" || ! -f "$secret_raw_report" || -L "$secret_raw_report" ]] \
    || ! printf '%s' "$receipt_sha256" | grep -qxE '[0-9a-f]{64}'; then
    echo "ERROR: cached mcporter audit requires paired receipt, raw report, and receipt SHA-256" >&2
    exit 1
  fi
  receipt="$secret_receipt"
  raw_report="$secret_raw_report"
elif [[ -e "$seed_root" || -L "$seed_root" ]]; then
  receipt="$seed_root/mcporter-runtime.receipt.json"
  raw_report="$seed_root/mcporter-runtime.raw.json"
  hash_file="$seed_root/mcporter-runtime.receipt.sha256"
  if [[ ! -d "$seed_root" || -L "$seed_root" || ! -f "$receipt" || -L "$receipt" || ! -f "$raw_report" || -L "$raw_report" || ! -f "$hash_file" || -L "$hash_file" ]]; then
    echo "ERROR: seed-cached mcporter audit evidence is incomplete" >&2
    exit 1
  fi
  read -r receipt_sha256 <"$hash_file"
  if ! printf '%s' "$receipt_sha256" | grep -qxE '[0-9a-f]{64}'; then
    echo "ERROR: seed-cached mcporter audit receipt SHA-256 is invalid" >&2
    exit 1
  fi
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
