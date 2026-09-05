#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "ERROR: reviewed npm identity path is required." >&2
  exit 1
fi

config_file="$1"
download_dir="$(mktemp -d "$RUNNER_TEMP/reviewed-npm.XXXXXX")"
trap 'rm -rf "$download_dir"' EXIT
identity_file="$download_dir/identity"

node --input-type=module - "$config_file" >"$identity_file" <<'NODE'
import { readFileSync } from "node:fs";

const [configFile] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, "utf8"));
if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(config.npmVersion)) {
  throw new Error("reviewed npm audit configuration has an invalid npmVersion");
}
if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(config.npmIntegrity)) {
  throw new Error("reviewed npm audit configuration has an invalid npmIntegrity");
}
if (!/^[a-f0-9]{64}$/.test(config.npmArchiveSha256)) {
  throw new Error("reviewed npm audit configuration has an invalid npmArchiveSha256");
}
process.stdout.write(`${config.npmVersion}\n${config.npmIntegrity}\n${config.npmArchiveSha256}\n`);
NODE

IFS= read -r version <"$identity_file"
IFS= read -r expected_integrity < <(sed -n '2p' "$identity_file")
IFS= read -r expected_sha256 < <(sed -n '3p' "$identity_file")
[ -n "$version" ]
[ -n "$expected_integrity" ]
[ -n "$expected_sha256" ]

npm pack "npm@$version" \
  --pack-destination "$download_dir" \
  --userconfig /dev/null \
  --registry https://registry.npmjs.org/ \
  --ignore-scripts --no-audit --no-fund >/dev/null

archive="$download_dir/npm-$version.tgz"
actual_hashes="$download_dir/actual-hashes"
node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const archive = fs.readFileSync(process.argv[1]);
  process.stdout.write(
    crypto.createHash("sha512").update(archive).digest("base64") + "\n" +
    crypto.createHash("sha256").update(archive).digest("hex") + "\n",
  );
' "$archive" >"$actual_hashes"
IFS= read -r actual_sha512 <"$actual_hashes"
IFS= read -r actual_sha256 < <(sed -n '2p' "$actual_hashes")
actual_integrity="sha512-$actual_sha512"
if [ "$actual_integrity" != "$expected_integrity" ] || [ "$actual_sha256" != "$expected_sha256" ]; then
  echo "ERROR: npm@$version archive integrity mismatch." >&2
  exit 1
fi

npm install --global "$archive" \
  --userconfig /dev/null \
  --ignore-scripts --no-audit --no-fund --offline

installed_version="$(npm --version)"
if [ "$installed_version" != "$version" ]; then
  echo "ERROR: installed npm@$installed_version does not match reviewed npm@$version." >&2
  exit 1
fi
