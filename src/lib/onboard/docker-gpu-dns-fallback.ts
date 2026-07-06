// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

function parseResolvConfNameservers(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("nameserver"))
    .map((line) => line.split(/\s+/)[1])
    .filter((ip): ip is string => Boolean(ip));
}

/**
 * Resolve a non-loopback upstream when the sandbox would inherit systemd-resolved's stub.
 * This host-only probe runs during container creation; only the selected address is passed to
 * Docker via `--dns`, and the sandbox receives no runtime access to either host file.
 */
export function detectSandboxFallbackDns(
  deps: { readFile?: (path: string) => string | null } = {},
): string | null {
  const readFile =
    deps.readFile ??
    ((path: string): string | null => {
      try {
        return fs.readFileSync(path, "utf-8");
      } catch {
        return null;
      }
    });
  const resolvConf = readFile("/etc/resolv.conf");
  if (!resolvConf) return null;
  const nameservers = parseResolvConfNameservers(resolvConf);
  if (nameservers.length === 0 || !nameservers.every((ip) => /^127\./.test(ip))) return null;
  const upstreamFile = readFile("/run/systemd/resolve/resolv.conf");
  return upstreamFile
    ? (parseResolvConfNameservers(upstreamFile).find((ip) => !/^127\./.test(ip)) ?? null)
    : null;
}
