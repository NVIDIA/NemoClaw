#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

version="${NEMOCLAW_REVIEWED_NPM_VERSION:?}"
expected_integrity="${NEMOCLAW_REVIEWED_NPM_INTEGRITY:?}"
download_dir="$(mktemp -d "$RUNNER_TEMP/reviewed-npm.XXXXXX")"

npm pack "npm@$version" \
  --pack-destination "$download_dir" \
  --userconfig /dev/null \
  --registry https://registry.npmjs.org/ \
  --ignore-scripts --no-audit --no-fund >/dev/null

archive="$download_dir/npm-$version.tgz"
actual_sha512="$(
  node -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    process.stdout.write(crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"));
  ' "$archive"
)"
actual_integrity="sha512-$actual_sha512"
if [ "$actual_integrity" != "$expected_integrity" ]; then
  echo "ERROR: npm@$version archive integrity mismatch." >&2
  exit 1
fi

npm install --global "$archive" \
  --userconfig /dev/null \
  --ignore-scripts --no-audit --no-fund --offline
