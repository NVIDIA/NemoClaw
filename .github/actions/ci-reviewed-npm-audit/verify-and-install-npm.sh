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
identity_file="$download_dir/identity"

node --experimental-strip-types --input-type=module - \
  "$config_file" \
  "$script_dir/../../../scripts/lib/reviewed-npm-audit.mts" >"$identity_file" <<'NODE'
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [configFile, reviewedNpmAuditFile] = process.argv.slice(2);
const { parseReviewedNpmIdentityConfig } = await import(pathToFileURL(reviewedNpmAuditFile).href);
const identity = parseReviewedNpmIdentityConfig(readFileSync(configFile, "utf8"));
process.stdout.write(`${identity.npmVersion}\n${identity.npmIntegrity}\n${identity.npmArchiveSha256}\n`);
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

archive_version="$(
  tar -xOf "$archive" package/package.json | node -e '
    let source = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { source += chunk; });
    process.stdin.on("end", () => {
      const version = JSON.parse(source).version;
      if (typeof version !== "string") process.exit(1);
      process.stdout.write(version);
    });
  '
)"
if [ "$archive_version" != "$version" ]; then
  echo "ERROR: npm archive version $archive_version does not match reviewed npm@$version." >&2
  exit 1
fi

npm install --global "$archive" \
  --userconfig /dev/null \
  --ignore-scripts --no-audit --no-fund --offline
