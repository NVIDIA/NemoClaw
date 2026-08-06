#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

script_dir=$(
  CDPATH=''
  cd -- "$(dirname -- "$0")"
  pwd
)
cd "$script_dir"

# Self-hosted GPU builders can have a much smaller connection budget than
# hosted builders, while dual-stack DNS can add a second failure path. Keep the
# reviewed install deterministic while bounding each registry attempt and the
# number of sockets npm can consume. These settings do not weaken lockfile,
# signature, or audit verification below.
export NODE_OPTIONS="${NODE_OPTIONS:---dns-result-order=ipv4first}"
export NPM_CONFIG_MAXSOCKETS="${NPM_CONFIG_MAXSOCKETS:-4}"
export NPM_CONFIG_FETCH_RETRIES="${NPM_CONFIG_FETCH_RETRIES:-5}"
export NPM_CONFIG_FETCH_RETRY_MINTIMEOUT="${NPM_CONFIG_FETCH_RETRY_MINTIMEOUT:-1000}"
export NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT="${NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT:-20000}"
export NPM_CONFIG_FETCH_TIMEOUT="${NPM_CONFIG_FETCH_TIMEOUT:-60000}"

if [ -n "${NEMOCLAW_CORPORATE_CA_B64:-}" ]; then
  command -v base64 >/dev/null 2>&1 || {
    echo "[nemoclaw] base64 is required to decode the corporate CA for the MCP discovery runtime" >&2
    exit 1
  }
  install -d -m 0755 /usr/local/share/nemoclaw
  decoded=$(mktemp)
  trap 'rm -f "$decoded"' EXIT
  ca_file=/usr/local/share/nemoclaw/mcp-runtime-corporate-ca.pem
  if ! printf '%s' "$NEMOCLAW_CORPORATE_CA_B64" | base64 --decode >"$decoded" 2>/dev/null; then
    echo "[nemoclaw] the corporate CA for the MCP discovery runtime is not valid base64" >&2
    exit 1
  fi
  awk '/-----BEGIN CERTIFICATE-----/{f=1} f{print} /-----END CERTIFICATE-----/{f=0}' \
    "$decoded" >"$ca_file"
  rm -f "$decoded"
  trap - EXIT
  if ! node -e '
    const fs = require("node:fs");
    const { X509Certificate } = require("node:crypto");
    const pem = fs.readFileSync(process.argv[1], "utf8");
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certificates?.length) process.exit(1);
    for (const certificate of certificates) new X509Certificate(certificate);
  ' "$ca_file" >/dev/null 2>&1; then
    echo "[nemoclaw] the corporate CA for the MCP discovery runtime is not a valid X.509 bundle" >&2
    exit 1
  fi
  chown root:root "$ca_file"
  chmod 0444 "$ca_file"
  export NODE_EXTRA_CA_CERTS="$ca_file"
fi

./npm-ci-locked.sh --ignore-scripts --no-audit --no-fund --no-progress
npm audit signatures
npm test
npm run typecheck
npm run bundle
npm audit --omit=dev --audit-level=low
