// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Preflight warning when the user's shell has HTTP_PROXY set without a
 * NO_PROXY=localhost,127.0.0.1 bypass. See #2616.
 *
 * NemoClaw's own subprocess spawn helpers (`buildSubprocessEnv`) inject
 * NO_PROXY for loopback hosts, so NemoClaw-managed processes are safe. But
 * any tool the user runs that respects HTTP_PROXY (curl, Node fetch,
 * Python requests) inherits the user's environment and will still tunnel
 * localhost traffic through the host proxy — common on macOS with Privoxy
 * at 127.0.0.1:8118.
 */
export function warnIfHostProxyMissesLoopback(
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = (line) => console.warn(line),
): boolean {
  const proxyEnv = env.HTTP_PROXY || env.http_proxy;
  if (!proxyEnv) return false;
  const noProxyEnv = env.NO_PROXY || env.no_proxy || "";
  // Require BOTH entries — HTTP libraries match the literal hostname against
  // NO_PROXY, so `NO_PROXY=localhost` alone still proxies `127.0.0.1` requests
  // (and vice versa). Only suppress the warning when both are present.
  const hasLocalhost = /(^|,)\s*localhost\s*(,|$)/.test(noProxyEnv);
  const hasLoopback = /(^|,)\s*127\.0\.0\.1\s*(,|$)/.test(noProxyEnv);
  if (hasLocalhost && hasLoopback) return false;
  warn("  ⚠ HTTP_PROXY/http_proxy is set without NO_PROXY=localhost,127.0.0.1.");
  warn(`    Detected proxy: ${redactProxyCredentials(proxyEnv)}`);
  warn("    NemoClaw injects NO_PROXY for its own subprocess spawns, but any tool you run");
  warn("    that respects HTTP_PROXY (curl, Node fetch, Python requests) will still tunnel");
  warn("    localhost traffic through your host proxy. To bypass loopback (see #2616):");
  warn("      export NO_PROXY=localhost,127.0.0.1");
  warn("      export no_proxy=localhost,127.0.0.1");
  return true;
}

/**
 * Redact basic-auth credentials from a proxy URL before logging. HTTP_PROXY
 * vars sometimes carry `http://user:password@proxy:3128`; logging that raw
 * leaks secrets into terminal scrollback, screenshots, and support tickets.
 */
export function redactProxyCredentials(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = "****";
      u.password = "";
      return u.toString();
    }
    return raw;
  } catch {
    // Not a parseable URL — fall back to regex over the userinfo segment.
    return raw.replace(/(\/\/)[^/@]+@/, "$1****@");
  }
}
