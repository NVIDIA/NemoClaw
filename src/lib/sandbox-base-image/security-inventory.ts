// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture } from "../adapters/docker";

const SECURITY_INVENTORY_PROBE_OK = "nemoclaw-security-inventory-ok";

export const SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY = [
  "libexpat1=2.8.3-1",
  "libonig5=6.9.9-1+b1",
  "libjq1=1.8.2-1",
  "jq=1.8.2-1",
  "vim-common=2:9.2.0858-1",
  "vim-tiny=2:9.2.0858-1",
  "libssh2-1t64=1.11.1-1+deb13u1+nemoclaw2",
  "libssl3t64=3.5.7-1~deb13u2",
  "nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u4+nemoclaw1",
  "perl-base=5.44.0-1nemoclaw1",
  "perl=5.44.0-1nemoclaw1",
] as const;

const SECURITY_PACKAGE_INVENTORY_SHELL_ARGUMENTS = SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY.map(
  (packageSpec) => `"${packageSpec}"`,
).join(" ");

/**
 * Reject a published or cached base that predates the immutable security
 * package inventory consumed by completed-image verification.
 */
export function sandboxBaseImageHasSecurityInventory(imageRef: string): boolean {
  const output = dockerCapture(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--entrypoint",
      "/bin/sh",
      imageRef,
      "-c",
      [
        "set -eu",
        "security_inventory=/usr/local/share/nemoclaw/security-packages.txt",
        'arch="$(dpkg --print-architecture)"',
        'test -f "$security_inventory"',
        'test ! -L "$security_inventory"',
        `test "$(stat -c '%u:%g:%a' "$security_inventory")" = "0:0:444"`,
        `printf '%s\\n' "architecture=$arch" ${SECURITY_PACKAGE_INVENTORY_SHELL_ARGUMENTS} | cmp -s - "$security_inventory"`,
        `printf '%s\\n' "${SECURITY_INVENTORY_PROBE_OK}"`,
      ].join("; "),
    ],
    { ignoreError: true, timeout: 20_000 },
  );
  return output.trim() === SECURITY_INVENTORY_PROBE_OK;
}
