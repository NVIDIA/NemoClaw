#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Usage: verify-macos-signatures.sh BUNDLE TEAM
#
# Verify that every program in a darwin bundle directory has the notarized
# Developer ID signature signing-inventory.sh assigns it: the Apple team TEAM's
# for the programs NVIDIA signs, and HashiCorp's for the Helm provider. A
# Mach-O file holds one signature, so signing the Helm provider again would
# replace HashiCorp's.
#
# `codesign --verify --strict` alone accepts ad hoc signatures, such as
# OpenTofu's own, so the requirement names the signer and notarization. Each
# check's verbose output on standard error is the release's evidence.
set -euo pipefail

bundle=$1
team=$2
hashicorp=D38WU7D763
inventory=$(bash "$(dirname "$0")/signing-inventory.sh" "$bundle" darwin_arm64)
checked=0
failed=0
while IFS=$'\t' read -r owner name; do
  case "$owner" in
    nvidia) signer=$team ;;
    hashicorp) signer=$hashicorp ;;
    *) continue ;;
  esac
  checked=$((checked + 1))
  if ! codesign --verify --strict --check-notarization --verbose=2 \
    -R="notarized and anchor apple generic and certificate leaf[subject.OU] = \"$signer\"" "$bundle/$name"; then
    echo "::error::$name isn't notarized with a Developer ID signature from team $signer"
    failed=1
  fi
done <<< "$inventory"
if [ "$checked" -eq 0 ]; then
  echo "::error::$bundle holds no executables"
  exit 1
fi
exit "$failed"
