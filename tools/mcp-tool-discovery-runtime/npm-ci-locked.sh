#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

install_log=$(mktemp)
trap 'rm -f "$install_log"' EXIT

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
seed_dir="$script_dir/npm-cache-seed"
if [ -d "$seed_dir" ]; then
  for seed_archive in "$seed_dir"/*.tgz; do
    if ! node - "$seed_archive" <<'NODE'; then
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const archive = process.argv[2];
const archiveStat = fs.lstatSync(archive);
const archiveName = path.basename(archive);
const integrity = `sha512-${crypto.createHash("sha512").update(fs.readFileSync(archive)).digest("base64")}`;
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const matches = Object.values(lock.packages ?? {}).filter((entry) => {
  if (entry?.integrity !== integrity || typeof entry.resolved !== "string") return false;
  const resolved = new URL(entry.resolved);
  return (
    resolved.origin === "https://registry.npmjs.org" &&
    path.basename(resolved.pathname) === archiveName
  );
});

if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || matches.length !== 1) process.exit(1);
NODE
      echo "[nemoclaw] refusing an npm cache seed not uniquely pinned by package-lock.json: $seed_archive" >&2
      exit 1
    fi
    npm cache add "$seed_archive" >"$install_log" 2>&1 || {
      install_status=$?
      cat "$install_log" >&2
      exit "$install_status"
    }
  done
fi

if npm ci "$@" >"$install_log" 2>&1; then
  cat "$install_log"
else
  install_status=$?
  cat "$install_log" >&2
  if ! grep -Fq 'Exit handler never called!' "$install_log"; then
    exit "$install_status"
  fi

  # npm can emit its internal exit-handler failure after it has materialized a
  # complete, lockfile-validated dependency tree. Preserve that tree when npm's
  # own graph validator confirms it is complete. Rebuilding it first would
  # discard valid packages and can require registry archives that npm consumed
  # without committing to its content cache.
  if npm ls --all --json "$@" >"$install_log" 2>&1; then
    echo "[nemoclaw] npm hit its internal exit-handler failure after completing the locked dependency tree" >&2
    rm -f "$install_log"
    trap - EXIT
    exit 0
  fi

  echo "[nemoclaw] npm hit its internal exit-handler failure before completing the locked dependency tree; completing it offline from cache" >&2
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
