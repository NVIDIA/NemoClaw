// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { isIP } from "node:net";

export function parseResolvConfNameservers(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^nameserver(?:\s|$)/.test(line))
    .map((line) => line.split(/\s+/)[1])
    .filter((ip): ip is string => Boolean(ip) && isIP(ip) !== 0);
}

function isLoopbackResolver(ip: string): boolean {
  return /^127\./.test(ip) || ip === "::1";
}

function isUsableUpstreamResolver(ip: string): boolean {
  if (isLoopbackResolver(ip) || ip === "0.0.0.0" || ip === "::") return false;
  if (isIP(ip) === 4) {
    const firstOctet = Number(ip.split(".")[0]);
    // Keep unicast link-local resolvers: cloud hosts legitimately publish
    // addresses such as the Route 53 Resolver at 169.254.169.253.
    return firstOctet > 0 && firstOctet < 224;
  }
  return !/^ff/i.test(ip);
}

/**
 * Source-of-truth boundary for the compatibility container's DNS fallback:
 *
 * - Invalid state: a recreated container inherits a host-only systemd-resolved loopback stub and
 *   cannot resolve names from its own network namespace.
 * - Source boundary: the host resolver owns the upstream address and Docker owns the recreated
 *   container's `--dns` setting; the sandbox cannot repair either side after creation.
 * - Source-fix constraint: the compatibility path must recreate the OpenShell-managed container
 *   atomically, so it cannot reconfigure the host resolver or upgrade OpenShell/Docker in place.
 * - Regression coverage: docker-gpu-dns-fallback.test.ts validates resolver parsing and host-file
 *   failures; docker-gpu-patch-recreate-dns.test.ts validates the create-command envelope.
 * - Removal condition: remove this probe only when the compatibility recreation path is retired
 *   for every supported host, or the minimum supported OpenShell/Docker pair always supplies a
 *   non-loopback resolver to recreated containers.
 *
 * This host-only probe runs during container creation; only the selected address is passed to
 * Docker via `--dns`, and the sandbox receives no runtime access to either host file.
 */
export function detectSandboxFallbackDns(
  deps: { readFile?: (path: string) => string | null } = {},
): string | null {
  // `readFile` is a test seam, not a production path input. Production calls omit it, and this
  // function invokes either implementation only with the two hardcoded host resolver paths below.
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
  if (nameservers.length === 0 || !nameservers.every(isLoopbackResolver)) return null;
  const upstreamFile = readFile("/run/systemd/resolve/resolv.conf");
  return upstreamFile
    ? (parseResolvConfNameservers(upstreamFile).find(isUsableUpstreamResolver) ?? null)
    : null;
}
