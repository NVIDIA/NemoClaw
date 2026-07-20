#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

target_root="${NEMOCLAW_WECHAT_AUDIT_TARGET_ROOT:?target root is required}"
report_dir="${NEMOCLAW_WECHAT_AUDIT_REPORT_DIR:?report directory is required}"
target_root="$(cd "$target_root" && pwd -P)"
if [[ "$report_dir" != /* ]]; then
  report_dir="$target_root/$report_dir"
fi
runtime_dir="$target_root/agents/openclaw/wechat-runtime"
package_json="$runtime_dir/package.json"
package_lock="$runtime_dir/package-lock.json"
npm_registry="https://registry.npmjs.org/"

for input in "$runtime_dir" "$package_json" "$package_lock"; do
  if [[ -L "$input" ]]; then
    echo "WeChat runtime audit refuses symbolic-link input: $input" >&2
    exit 1
  fi
done

# The audited checkout must not influence npm's trust or registry configuration.
for npm_config in "$target_root/.npmrc" "$runtime_dir/.npmrc"; do
  if [[ -e "$npm_config" || -L "$npm_config" ]]; then
    echo "WeChat runtime audit refuses target-controlled npm config: $npm_config" >&2
    exit 1
  fi
done
runtime_dir="$(cd "$runtime_dir" && pwd -P)"
case "$runtime_dir/" in
  "$target_root"/*) ;;
  *)
    echo "WeChat runtime directory escaped the target checkout: $runtime_dir" >&2
    exit 1
    ;;
esac

trusted_cache="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-wechat-trusted-cache.XXXXXX")"
install_cache="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-wechat-install-cache.XXXXXX")"
pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-wechat-pack.XXXXXX")"
trusted_npmrc="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-wechat-npmrc.XXXXXX")"
printf 'registry=%s\n' "$npm_registry" >"$trusted_npmrc"
chmod 600 "$trusted_npmrc"

cleanup() {
  chmod -R u+w "$trusted_cache" "$install_cache" "$pack_dir" 2>/dev/null || true
  rm -rf "$trusted_cache" "$install_cache" "$pack_dir" "$runtime_dir/node_modules"
  rm -f "$trusted_npmrc"
}
trap cleanup EXIT

mkdir -p "$report_dir"

package_identity_output="$(
  PACKAGE_JSON="$package_json" PACKAGE_LOCK="$package_lock" NPM_REGISTRY_ORIGIN="${npm_registry%/}" node <<'NODE'
const fs = require("node:fs");
const packageJson = JSON.parse(fs.readFileSync(process.env.PACKAGE_JSON, "utf8"));
const packageLock = JSON.parse(fs.readFileSync(process.env.PACKAGE_LOCK, "utf8"));
const registryOrigin = process.env.NPM_REGISTRY_ORIGIN;

function requireRegistryUrl(resolved, location) {
  if (typeof resolved !== "string") {
    throw new Error(`locked package lacks a resolved URL: ${location}`);
  }
  let parsed;
  try {
    parsed = new URL(resolved);
  } catch {
    throw new Error(`locked package has an invalid resolved URL: ${location}`);
  }
  if (parsed.origin !== registryOrigin || parsed.username || parsed.password) {
    throw new Error(`locked package must resolve from the reviewed npm registry origin: ${location}`);
  }
}

const dependencyNames = Object.keys(packageJson.dependencies ?? {});
if (dependencyNames.length !== 1 || dependencyNames[0] !== "@tencent-weixin/openclaw-weixin") {
  throw new Error("WeChat runtime package.json must contain exactly the reviewed plugin dependency");
}
const version = packageJson.dependencies[dependencyNames[0]];
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("WeChat runtime dependency must use an exact numeric version");
}
if (packageLock.lockfileVersion !== 3) {
  throw new Error(`WeChat runtime lockfileVersion must be 3, got ${packageLock.lockfileVersion}`);
}
const rootDependency = packageLock.packages?.[""]?.dependencies?.[dependencyNames[0]];
const plugin = packageLock.packages?.[`node_modules/${dependencyNames[0]}`];
if (rootDependency !== version || plugin?.version !== version) {
  throw new Error("WeChat runtime package and lock identities do not match");
}
if (typeof plugin.integrity !== "string" || !plugin.integrity.startsWith("sha512-")) {
  throw new Error("WeChat runtime plugin lock entry must carry sha512 integrity");
}
requireRegistryUrl(plugin.resolved, `node_modules/${dependencyNames[0]}`);
const peerRange = plugin.peerDependencies?.openclaw;
if (typeof peerRange !== "string" || peerRange.length === 0) {
  throw new Error("WeChat runtime plugin lock entry must declare its OpenClaw peer range");
}
for (const [location, record] of Object.entries(packageLock.packages ?? {})) {
  if (!location.startsWith("node_modules/")) continue;
  if (typeof record.version !== "string" || typeof record.integrity !== "string") {
    throw new Error(`locked package lacks version or integrity: ${location}`);
  }
  requireRegistryUrl(record.resolved, location);
}
process.stdout.write(`${dependencyNames[0]}@${version}\n${plugin.resolved}\n${plugin.integrity}\n`);
NODE
)"
readarray -t package_identity <<<"$package_identity_output"
if [[ ${#package_identity[@]} -ne 3 ]] \
  || [[ -z "${package_identity[0]}" || -z "${package_identity[1]}" || -z "${package_identity[2]}" ]]; then
  echo "ERROR: WeChat runtime package validation returned incomplete identity metadata" >&2
  exit 1
fi
wechat_spec="${package_identity[0]}"
wechat_tarball="${package_identity[1]}"
wechat_integrity="${package_identity[2]}"

# Materialize the PR-provided dependency graph without executing dependency scripts.
npm --prefix "$runtime_dir" ci \
  --userconfig "$trusted_npmrc" \
  --registry "$npm_registry" \
  --ignore-scripts \
  --omit=dev \
  --legacy-peer-deps \
  --no-audit \
  --no-fund \
  --cache "$trusted_cache"
for package_spec in "$wechat_spec" "qrcode-terminal@0.12.0" "zod@4.4.3"; do
  npm cache add "$package_spec" \
    --userconfig "$trusted_npmrc" \
    --registry "$npm_registry" \
    --cache "$trusted_cache"
done

audit_status=0
npm --prefix "$runtime_dir" audit \
  --userconfig "$trusted_npmrc" \
  --registry "$npm_registry" \
  --omit=dev \
  --audit-level=low \
  --json >"$report_dir/npm-audit.json" || audit_status=$?

signature_status=0
npm --prefix "$runtime_dir" audit signatures \
  --userconfig "$trusted_npmrc" \
  --registry "$npm_registry" \
  >"$report_dir/npm-audit-signatures.txt" 2>&1 || signature_status=$?

# Reproduce the sandbox-user npm-pack boundary with the exact reviewed archive.
# The trusted source cache is read-only; only its short-lived copy is writable.
chmod -R a-w "$trusted_cache"
cp -R "$trusted_cache"/. "$install_cache"/
chmod -R u+rwX,go-w "$install_cache"
npm pack "$wechat_tarball" \
  --userconfig "$trusted_npmrc" \
  --registry "$npm_registry" \
  --offline \
  --cache "$install_cache" \
  --pack-destination "$pack_dir" \
  --json >"$report_dir/npm-pack.json"

TRUSTED_CACHE="$trusted_cache" \
  PACK_DIR="$pack_dir" \
  PACK_REPORT="$report_dir/npm-pack.json" \
  EXPECTED_INTEGRITY="$wechat_integrity" \
  node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const trustedCache = process.env.TRUSTED_CACHE;
const packDir = path.resolve(process.env.PACK_DIR);
const report = JSON.parse(fs.readFileSync(process.env.PACK_REPORT, "utf8"));
const entry = report[0] ?? {};
if (entry.integrity !== process.env.EXPECTED_INTEGRITY) {
  throw new Error(`reviewed WeChat archive integrity mismatch: ${entry.integrity ?? "missing"}`);
}
const filename = String(entry.filename ?? "");
if (!filename || path.basename(filename) !== filename) {
  throw new Error(`npm pack reported an unsafe filename: ${filename || "missing"}`);
}
const archive = path.resolve(packDir, filename);
if (!archive.startsWith(`${packDir}${path.sep}`) || !fs.statSync(archive).isFile()) {
  throw new Error(`npm pack archive escaped its destination: ${filename}`);
}

const pending = [trustedCache];
while (pending.length > 0) {
  const current = pending.pop();
  const stats = fs.lstatSync(current);
  if ((stats.mode & 0o222) !== 0) {
    throw new Error(`trusted WeChat cache entry remained writable: ${current}`);
  }
  if (stats.isDirectory()) {
    for (const child of fs.readdirSync(current)) pending.push(path.join(current, child));
  }
}
NODE

if ((audit_status != 0)); then
  echo "WeChat runtime npm audit failed at audit-level=low; see $report_dir/npm-audit.json" >&2
  exit "$audit_status"
fi
if ((signature_status != 0)); then
  echo "WeChat runtime npm signature audit failed; see $report_dir/npm-audit-signatures.txt" >&2
  exit "$signature_status"
fi

echo "WeChat runtime graph, audit, signatures, and writable install-cache boundary passed."
