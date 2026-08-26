#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

candidate_npmrc="$(find . -path './.git' -prune -o -name .npmrc -print -quit)"
if [ -n "$candidate_npmrc" ]; then
  echo "Candidate repository npm configuration is not allowed during trusted dependency installation." >&2
  exit 1
fi

for shrinkwrap in npm-shrinkwrap.json nemoclaw/npm-shrinkwrap.json; do
  if [ -e "$shrinkwrap" ]; then
    echo "Candidate npm shrinkwrap files are not allowed during trusted dependency installation." >&2
    exit 1
  fi
done

event_name="${GITHUB_EVENT_NAME:-local}"
package_mode="registry"
if [ "$event_name" = "pull_request" ]; then
  package_mode="artifact"
  if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
    echo "Pull request dependency installation must not receive a package credential." >&2
    exit 1
  fi
fi

target_root="$(pwd -P)"
trusted_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
npm_cache="${NPM_CONFIG_CACHE:-${RUNNER_TEMP:-$target_root/.ci-cache}/npm}"
mkdir -p "$npm_cache"

NEMOCLAW_CI_NPM_CACHE="$npm_cache" \
  NEMOCLAW_CI_NPM_PACKAGE_MODE="$package_mode" \
  NEMOCLAW_CI_TARGET_ROOT="$target_root" \
  NEMOCLAW_OPEN_SHELL_SDK_ARTIFACT_DIRECTORY="${RUNNER_TEMP:-$target_root/.ci-artifacts}/openshell-sdk" \
  node --experimental-strip-types "$trusted_root/scripts/checks/prepare-ci-npm-install.mts"

trusted_npmrc=""
cleanup() {
  if [ -n "$trusted_npmrc" ]; then
    rm -f "$trusted_npmrc"
  fi
}
trap cleanup EXIT

if [ "$package_mode" = "registry" ] && [ -n "${NODE_AUTH_TOKEN:-}" ]; then
  trusted_npmrc="${RUNNER_TEMP:-$target_root/.ci-cache}/trusted-npmrc"
  mkdir -p "$(dirname "$trusted_npmrc")"
  umask 077
  printf '%s\n' \
    '@nvidia:registry=https://npm.pkg.github.com' \
    "//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}" >"$trusted_npmrc"
  export NPM_CONFIG_USERCONFIG="$trusted_npmrc"
fi

npm ci --ignore-scripts --prefer-offline --cache "$npm_cache"
npm --prefix nemoclaw ci --ignore-scripts --prefer-offline --cache "$npm_cache"
