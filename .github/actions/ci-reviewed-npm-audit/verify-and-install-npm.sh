#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "ERROR: reviewed npm identity path is required." >&2
  exit 1
fi

config_file="$1"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
download_dir="$(mktemp -d "$RUNNER_TEMP/reviewed-npm.XXXXXX")"
trap 'rm -rf "$download_dir"' EXIT

IFS=$'\t' read -r version expected_integrity expected_sha256 < <(
  node --input-type=module - \
    "$config_file" \
    "$script_dir/../../../scripts/lib/reviewed-npm-audit.mts" <<'NODE'
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [configFile, reviewedNpmAuditFile] = process.argv.slice(2);
const { parseReviewedNpmIdentityConfig } = await import(pathToFileURL(reviewedNpmAuditFile).href);
const identity = parseReviewedNpmIdentityConfig(readFileSync(configFile, "utf8"));
process.stdout.write(`${identity.npmVersion}\t${identity.npmIntegrity}\t${identity.npmArchiveSha256}\n`);
NODE
)
[ -n "$version" ]
[ -n "$expected_integrity" ]
[ -n "$expected_sha256" ]

npm pack "npm@$version" \
  --pack-destination "$download_dir" \
  --userconfig /dev/null \
  --registry https://registry.npmjs.org/ \
  --ignore-scripts --no-audit --no-fund >/dev/null

archive="$download_dir/npm-$version.tgz"
IFS=$'\t' read -r actual_sha512 actual_sha256 < <(node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const archive = fs.readFileSync(process.argv[1]);
  process.stdout.write(
    crypto.createHash("sha512").update(archive).digest("base64") + "\t" +
    crypto.createHash("sha256").update(archive).digest("hex") + "\n",
  );
' "$archive")
actual_integrity="sha512-$actual_sha512"
if [ "$actual_integrity" != "$expected_integrity" ] || [ "$actual_sha256" != "$expected_sha256" ]; then
  echo "ERROR: npm@$version archive integrity mismatch." >&2
  exit 1
fi

if ! archive_version="$(
  tar -xOf "$archive" package/package.json | node -e '
    const version = JSON.parse(require("node:fs").readFileSync(0, "utf8")).version;
    if (typeof version !== "string") process.exit(1);
    process.stdout.write(version);
  '
)"; then
  echo "ERROR: npm@$version archive package/package.json is missing or invalid." >&2
  exit 1
fi
if [ "$archive_version" != "$version" ]; then
  echo "ERROR: npm archive version $archive_version does not match reviewed npm@$version." >&2
  exit 1
fi

npm install --global "$archive" \
  --userconfig /dev/null \
  --ignore-scripts --no-audit --no-fund --offline
