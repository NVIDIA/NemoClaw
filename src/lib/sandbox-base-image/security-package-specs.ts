// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const CURRENT_PYTHON_HTMLPARSER_FIX_PACKAGE =
  "nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u5+nemoclaw1";
const PINNED_HERMES_BASE_PYTHON_HTMLPARSER_FIX_PACKAGE =
  "nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u4+nemoclaw1";

export const SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY = [
  "zlib1g=1:1.3.dfsg+really1.3.1-1+b1+nemoclaw1",
  "libc6=2.41-12+deb13u4",
  "libc-bin=2.41-12+deb13u4",
  "bsdutils=1:2.41.5-0+deb13u1",
  "login=1:4.16.0-2+really2.41.5-0+deb13u1",
  "mount=2.41.5-0+deb13u1",
  "util-linux=2.41.5-0+deb13u1",
  "libblkid1=2.41.5-0+deb13u1",
  "liblastlog2-2=2.41.5-0+deb13u1",
  "libmount1=2.41.5-0+deb13u1",
  "libsmartcols1=2.41.5-0+deb13u1",
  "libuuid1=2.41.5-0+deb13u1",
  "libpcre2-8-0=10.46-1~deb13u3",
  "libsqlite3-0=3.46.1-7+deb13u2",
  "gzip=1.13-1+deb13u1",
  "libexpat1=2.8.3-1",
  "libonig5=6.9.9-1+b1",
  "libjq1=1.8.2-1",
  "jq=1.8.2-1",
  "vim-common=2:9.2.0858-1",
  "vim-tiny=2:9.2.0858-1",
  "libssh2-1t64=1.11.1-1+deb13u2+nemoclaw2",
  "libssl3t64=3.5.7-1~deb13u3",
  CURRENT_PYTHON_HTMLPARSER_FIX_PACKAGE,
  "perl-base=5.44.0-1nemoclaw1",
  "perl=5.44.0-1nemoclaw1",
] as const;

export const PINNED_HERMES_BASE_SECURITY_PACKAGE_INVENTORY =
  SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY.map((packageSpec) =>
    packageSpec === CURRENT_PYTHON_HTMLPARSER_FIX_PACKAGE
      ? PINNED_HERMES_BASE_PYTHON_HTMLPARSER_FIX_PACKAGE
      : packageSpec,
  );

export const OPENCLAW_SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY = [
  ...SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY,
  "libevent-core-2.1-7t64=2.1.13-stable-1",
] as const;

export const SECURITY_INVENTORY_PROBE_OK = "nemoclaw-security-inventory-ok";
export const SANDBOX_BASE_NODE_VERSION = "24.22.1";

/** Shared by image builds, CI base selection, and the installed CLI. */
export function securityInventoryProbe(
  packageInventory: readonly string[],
  compatibleInventory?: readonly string[],
): string {
  const expected = (specs: readonly string[]): string => {
    for (const spec of specs) {
      if (!/^[a-z0-9][a-z0-9+.-]*=[0-9A-Za-z.+:~_-]+$/.test(spec)) {
        throw new Error(`Invalid security package specification: ${spec}`);
      }
    }
    return `printf '%s\\n' "architecture=$arch" ${specs.map((spec) => `"${spec}"`).join(" ")} | cmp -s - "$security_inventory"`;
  };
  const comparison = compatibleInventory
    ? `{ ${expected(packageInventory)}; } || { ${expected(compatibleInventory)}; }`
    : expected(packageInventory);
  return [
    "set -eu",
    "security_inventory=/usr/local/share/nemoclaw/security-packages.txt",
    'arch="$(dpkg --print-architecture)"',
    'test -f "$security_inventory"',
    'test ! -L "$security_inventory"',
    `test "$(stat -c '%u:%g:%a' "$security_inventory")" = "0:0:444"`,
    comparison,
    // Node's bundled native libraries are outside dpkg and npm audit coverage.
    `test "$(node -p 'process.versions.node')" = "${SANDBOX_BASE_NODE_VERSION}"`,
    // Check installed packages after authenticating the complete file contents.
    // A current manifest alongside an obsolete library must not admit a base.
    'while IFS="=" read -r package version; do',
    '  if [ "$package" = architecture ]; then continue; fi',
    '  test "$(dpkg-query -W -f=\'${Version}\' "$package")" = "$version"',
    'done < "$security_inventory"',
    `printf '%s\\n' "${SECURITY_INVENTORY_PROBE_OK}"`,
  ].join("\n");
}
