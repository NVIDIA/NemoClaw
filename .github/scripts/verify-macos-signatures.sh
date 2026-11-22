#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Usage: verify-macos-signatures.sh BUNDLE TEAM [notarized|signatures-only]
#
# Verify that every program in a darwin bundle directory has the
# Developer ID signature signing-inventory.sh assigns it: the Apple team TEAM's
# for the programs NVIDIA signs, and HashiCorp's for the Helm provider. A
# Mach-O file holds one signature, so signing the Helm provider again would
# replace HashiCorp's.
#
# `codesign --verify --strict` alone accepts ad hoc signatures, such as
# OpenTofu's own, so the requirement names the signer and notarization. Each
# check's verbose output on standard error is the release's evidence.
# The default requires notarization; signatures-only mode checks integrity and identity.
set -euo pipefail

bundle=$1
team=$2
mode=${3:-notarized}
checks=(--verify --strict --verbose=2)
notarized=
anchor='anchor apple generic'
case "$mode" in
  notarized)
    checks+=(--check-notarization)
    notarized='notarized and '
    echo 'Notarization: required' ;;
  signatures-only) echo 'Notarization: skipped (signature verification only)' ;;
  *) echo "::error::Unknown macOS verification mode: $mode"; exit 1 ;;
esac
hashicorp=D38WU7D763
# macos-signing.rs names each NVIDIA program com.nvidia.nemoclaw.<program>,
# without a provider's _v<version> suffix, when it submits it to 3S.
identifier() {
  local stem=${1##*/}
  stem=${stem%%_v[0-9]*}
  printf 'com.nvidia.nemoclaw.%s' "${stem//[^A-Za-z0-9-]/-}"
}
inventory=$(bash "$(dirname "$0")/signing-inventory.sh" "$bundle" darwin_arm64)
checked=0
failed=0
while IFS=$'\t' read -r owner name; do
  case "$owner" in
    nvidia) signer=$team; requirement="${notarized}identifier \"$(identifier "$name")\" and $anchor" ;;
    hashicorp) signer=$hashicorp; requirement="$notarized$anchor" ;;
    *) continue ;;
  esac
  checked=$((checked + 1))
  if ! codesign "${checks[@]}" \
    -R="$requirement and certificate leaf[subject.OU] = \"$signer\"" "$bundle/$name"; then
    echo "::error::$name failed $mode verification for Developer ID team $signer"
    failed=1
  fi
done <<< "$inventory"
if [ "$checked" -eq 0 ]; then
  echo "::error::$bundle holds no executables"
  exit 1
fi
exit "$failed"
