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
 * SOURCE_OF_TRUTH_REVIEW (compatibility DNS fallback)
 * invalidState: a recreated container inherits a host-only loopback resolver.
 * sourceBoundary: host resolver files supply data only to Docker's `--dns`; the sandbox gets no
 *   file access, and syntactically valid unicast includes legitimate private/link-local resolvers.
 * whyNotSourceFix: atomic recreation cannot reconfigure the host or upgrade OpenShell/Docker.
 * regressionTest: DNS parser/host-file tests and the recreate-command envelope test.
 * removalCondition: compatibility is retired or supported stacks always supply non-loopback DNS.
 */
export function detectSandboxFallbackDns(
  deps: { readFile?: (path: string) => string | null } = {},
): string | null {
  // The test seam is invoked only with these hardcoded host-trusted paths; its result is data,
  // never a command.
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
