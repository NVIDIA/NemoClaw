#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Install the openshell CLI binary. Supports Linux and macOS (x86_64 and aarch64).

set -euo pipefail

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS/$ARCH" in
  Darwin/x86_64|Darwin/amd64)   ASSET="openshell-x86_64-apple-darwin.tar.gz" ;;
  Darwin/aarch64|Darwin/arm64)  ASSET="openshell-aarch64-apple-darwin.tar.gz" ;;
  Linux/x86_64|Linux/amd64)     ASSET="openshell-x86_64-unknown-linux-musl.tar.gz" ;;
  Linux/aarch64|Linux/arm64)    ASSET="openshell-aarch64-unknown-linux-musl.tar.gz" ;;
  *) echo "Unsupported platform: $OS/$ARCH"; exit 1 ;;
esac

tmpdir="$(mktemp -d)"
curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/latest/download/$ASSET" \
  -o "$tmpdir/openshell.tar.gz"
tar xzf "$tmpdir/openshell.tar.gz" -C "$tmpdir"

if [ -w /usr/local/bin ]; then
  install -m 755 "$tmpdir/openshell" /usr/local/bin/openshell
else
  sudo install -m 755 "$tmpdir/openshell" /usr/local/bin/openshell
fi

rm -rf "$tmpdir"
echo "openshell $(openshell --version 2>&1 || echo 'installed')"
