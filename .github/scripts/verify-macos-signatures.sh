#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Usage: verify-macos-signatures.sh BUNDLE TEAM
#
# Verify that every executable in a darwin bundle directory has a notarized
# Developer ID signature from the Apple team TEAM. The Helm provider keeps
# HashiCorp's notarized signature: a Mach-O file holds one signature, so
# signing it again would replace theirs.
#
# `codesign --verify --strict` alone accepts ad hoc signatures, such as
# OpenTofu's own, so the requirement names the signer and notarization.
set -euo pipefail

bundle=$1
team=$2
hashicorp=D38WU7D763
checked=0
failed=0
while IFS= read -r -d '' file; do
  name=${file#"$bundle"/}
  case "$name" in
    providers/*/terraform-provider-helm_*) signer=$hashicorp ;;
    *) signer=$team ;;
  esac
  checked=$((checked + 1))
  if ! codesign --verify --strict --check-notarization \
    -R="notarized and anchor apple generic and certificate leaf[subject.OU] = \"$signer\"" "$file"; then
    echo "::error::$name isn't notarized with a Developer ID signature from team $signer"
    failed=1
  fi
done < <(find "$bundle/bin" "$bundle/libexec" "$bundle/providers" -type f -print0)
if [ "$checked" -eq 0 ]; then
  echo "::error::$bundle holds no executables"
  exit 1
fi
exit "$failed"
