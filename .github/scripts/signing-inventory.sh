#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Usage: signing-inventory.sh BUNDLE PLATFORM
#
# Print each program in the bundle directory BUNDLE with whose signature it
# carries on PLATFORM, darwin_arm64 or windows_amd64, as `SIGNER<TAB>PATH`:
#
# - nvidia: NVIDIA signs it. NVIDIA builds nemoclaw and the NemoClaw providers.
# - hashicorp: the Helm provider keeps HashiCorp's Developer ID and
#   Authenticode signatures.
# - none: it stays as upstream ships it.
#
# OpenTofu and the Docker provider have only ad hoc signatures on macOS, where
# Gatekeeper checks every quarantined program NemoClaw starts, so NVIDIA signs
# them there. On Windows, SmartScreen doesn't check programs another program
# starts, so they stay unsigned (#14621). A program the inventory doesn't
# classify fails the script.
set -euo pipefail

bundle=$1
platform=$2
case "$platform" in
  darwin_arm64) third_party=nvidia ;;
  windows_amd64) third_party=none ;;
  *)
    echo "$platform has no OS code signing" >&2
    exit 1
    ;;
esac
programs=$(cd "$bundle" &&
  find . -type f \( -path './bin/*' -o -path './libexec/*' -o -path './providers/*' \) | sed 's|^\./||' | sort)
status=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    bin/nemoclaw | bin/nemoclaw.exe | providers/nvidia.github.io/nemoclaw/*) signer=nvidia ;;
    libexec/tofu | libexec/tofu.exe | libexec/openshell | providers/registry.opentofu.org/kreuzwerker/docker/*) signer=$third_party ;;
    providers/registry.opentofu.org/hashicorp/helm/*) signer=hashicorp ;;
    *)
      echo "$path isn't in the signing inventory; classify it in $0" >&2
      status=1
      continue
      ;;
  esac
  printf '%s\t%s\n' "$signer" "$path"
done <<< "$programs"
exit "$status"
