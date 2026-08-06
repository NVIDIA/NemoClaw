#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

install_log=$(mktemp)
trap 'rm -f "$install_log"' EXIT

if npm ci "$@" >"$install_log" 2>&1; then
  cat "$install_log"
else
  install_status=$?
  cat "$install_log" >&2
  if ! grep -Fq 'Exit handler never called!' "$install_log"; then
    exit "$install_status"
  fi

  echo "[nemoclaw] npm hit its internal exit-handler failure; completing the locked install offline from cache" >&2
  cache_fill_count=0
  while :; do
    rm -rf node_modules
    if npm ci "$@" --offline >"$install_log" 2>&1; then
      cat "$install_log"
      break
    fi

    install_status=$?
    cat "$install_log" >&2
    if ! grep -Fq 'npm error code ENOTCACHED' "$install_log"; then
      exit "$install_status"
    fi

    missing_count=$(
      sed -n 's|^npm error request to \(https://registry\.npmjs\.org/[^[:space:]]*\.tgz\) failed:.*|\1|p' "$install_log" \
        | sort -u \
        | wc -l \
        | tr -d '[:space:]'
    )
    missing_url=$(
      sed -n 's|^npm error request to \(https://registry\.npmjs\.org/[^[:space:]]*\.tgz\) failed:.*|\1|p' "$install_log" \
        | sort -u \
        | head -n 1
    )
    if [ "$missing_count" != 1 ] || [ -z "$missing_url" ]; then
      echo "[nemoclaw] offline npm retry did not identify exactly one registry archive" >&2
      exit "$install_status"
    fi
    if ! node - "$missing_url" <<'NODE'; then
const fs = require("node:fs");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const url = process.argv[2];
const matches = Object.values(lock.packages ?? {}).filter((entry) => entry?.resolved === url);
const integrities = new Set(matches.map((entry) => entry?.integrity).filter(Boolean));
if (matches.length === 0 || integrities.size !== 1) process.exit(1);
NODE
      echo "[nemoclaw] refusing an npm cache fill not uniquely pinned by package-lock.json" >&2
      exit "$install_status"
    fi

    cache_fill_count=$((cache_fill_count + 1))
    if [ "$cache_fill_count" -gt 8 ]; then
      echo "[nemoclaw] offline npm retry exceeded the bounded locked-archive cache fill" >&2
      exit "$install_status"
    fi
    echo "[nemoclaw] fetching one missing lockfile archive for offline retry: $missing_url" >&2
    cache_fetch_attempt=1
    while :; do
      if NPM_CONFIG_FETCH_RETRIES=0 NPM_CONFIG_FETCH_TIMEOUT=15000 \
        npm cache add "$missing_url" >"$install_log" 2>&1; then
        cat "$install_log"
        break
      else
        install_status=$?
      fi

      cat "$install_log" >&2
      if ! grep -Eq 'npm error code (EAI_AGAIN|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)' "$install_log"; then
        exit "$install_status"
      fi
      if [ "$cache_fetch_attempt" -ge 4 ]; then
        echo "[nemoclaw] missing lockfile archive fetch exhausted its bounded network retries" >&2
        exit "$install_status"
      fi

      echo "[nemoclaw] retrying the missing lockfile archive after a transient network failure" >&2
      sleep "$cache_fetch_attempt"
      cache_fetch_attempt=$((cache_fetch_attempt + 1))
    done
  done
fi

rm -f "$install_log"
trap - EXIT
