// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function selectDevMuslLinuxSandboxAssets(source: string): string {
  const historical = `    case "$ARCH_LABEL" in
      x86_64)
        ASSETS+=("openshell-gateway-x86_64-unknown-linux-gnu.tar.gz")
        ASSETS+=("openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz")
        ;;
      aarch64)
        ASSETS+=("openshell-gateway-aarch64-unknown-linux-gnu.tar.gz")
        ASSETS+=("openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz")
        ;;
    esac`;
  const devMusl = `    SANDBOX_LIBC="gnu"
    if [ "$RESOLVED_CHANNEL" = "dev" ]; then
      SANDBOX_LIBC="musl"
    fi
    case "$ARCH_LABEL" in
      x86_64)
        ASSETS+=("openshell-gateway-x86_64-unknown-linux-gnu.tar.gz")
        ASSETS+=("openshell-sandbox-x86_64-unknown-linux-\${SANDBOX_LIBC}.tar.gz")
        ;;
      aarch64)
        ASSETS+=("openshell-gateway-aarch64-unknown-linux-gnu.tar.gz")
        ASSETS+=("openshell-sandbox-aarch64-unknown-linux-\${SANDBOX_LIBC}.tar.gz")
        ;;
    esac`;
  const selected = source.replace(historical, devMusl);
  if (selected === source) throw new Error("historical Linux sandbox asset selection is missing");
  return selected;
}
