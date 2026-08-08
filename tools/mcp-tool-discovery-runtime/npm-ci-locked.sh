#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

install_log=$(mktemp)
seed_work_dir=$(mktemp -d)
cleanup() {
  rm -f -- "$install_log"
  rm -rf -- "$seed_work_dir"
}
trap cleanup EXIT

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
seed_dir="$script_dir/npm-cache-seed"
seed_archive_count=0
if [ -d "$seed_dir" ]; then
  for seed_source in "$seed_dir"/*.tgz "$seed_dir"/*.tgz.part-000; do
    [ -e "$seed_source" ] || continue
    case "$seed_source" in
      *.tgz)
        [ ! -e "${seed_source}.part-000" ] || {
          echo "[nemoclaw] refusing duplicate complete and chunked npm cache seeds: $seed_source" >&2
          exit 1
        }
        seed_archive="$seed_source"
        ;;
      *.tgz.part-000)
        seed_prefix=${seed_source%.part-000}
        seed_archive="$seed_work_dir/$(basename -- "$seed_prefix")"
        : >"$seed_archive"
        seed_part_index=0
        for seed_part in "${seed_prefix}".part-*; do
          expected_seed_part=$(printf '%s.part-%03d' "$seed_prefix" "$seed_part_index")
          if [ "$seed_part" != "$expected_seed_part" ] || [ ! -f "$seed_part" ] || [ -L "$seed_part" ]; then
            echo "[nemoclaw] refusing a non-contiguous or non-regular npm cache seed chunk: $seed_part" >&2
            exit 1
          fi
          cat -- "$seed_part" >>"$seed_archive"
          seed_part_index=$((seed_part_index + 1))
        done
        ;;
    esac
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

if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || matches.length === 0) process.exit(1);
NODE
      echo "[nemoclaw] refusing an npm cache seed not pinned by package-lock.json: $seed_archive" >&2
      exit 1
    fi
    npm cache add "$seed_archive" >"$install_log" 2>&1 || {
      install_status=$?
      cat "$install_log" >&2
      exit "$install_status"
    }
    seed_archive_count=$((seed_archive_count + 1))
  done
fi

# A materialized protected-build seed contains the complete target-specific
# lock graph. Consume it before attempting registry access: npm can otherwise
# hit its internal exit-handler failure after downloading an archive without
# committing that archive to its content cache, making the offline recovery
# path depend on registry DNS that protected GPU runners intentionally lack.
if [ "$seed_archive_count" -gt 0 ]; then
  if npm ci "$@" --offline >"$install_log" 2>&1; then
    cat "$install_log"
    cleanup
    trap - EXIT
    exit 0
  else
    install_status=$?
  fi

  cat "$install_log" >&2
  if grep -Fq 'Exit handler never called!' "$install_log" \
    && npm ls --all --json "$@" >"$install_log" 2>&1; then
    echo "[nemoclaw] npm hit its internal exit-handler failure after completing the seeded locked dependency tree" >&2
    cleanup
    trap - EXIT
    exit 0
  fi
  if ! grep -Fq 'npm error code ENOTCACHED' "$install_log"; then
    exit "$install_status"
  fi
  echo "[nemoclaw] pinned npm cache seed was incomplete; continuing with the bounded registry install" >&2
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
    cleanup
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

cleanup
trap - EXIT
