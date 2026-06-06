// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Preflight warning when the user's shell has HTTP_PROXY set without a
 * NO_PROXY bypass for loopback and the managed inference hostname.
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
  // Require all three entries — HTTP libraries match the literal hostname
  // against NO_PROXY, so partial coverage still proxies the missing entries.
  // Suppress the warning only when localhost, 127.0.0.1, and the managed
  // inference hostname are all present.
  const hasLocalhost = /(^|,)\s*localhost\s*(,|$)/.test(noProxyEnv);
  const hasLoopback = /(^|,)\s*127\.0\.0\.1\s*(,|$)/.test(noProxyEnv);
  const hasInference = /(^|,)\s*inference\.local\s*(,|$)/.test(noProxyEnv);
  if (hasLocalhost && hasLoopback && hasInference) return false;
  warn(
    "  ⚠ HTTP_PROXY/http_proxy is set without NO_PROXY=localhost,127.0.0.1,inference.local.",
  );
  warn(`    Detected proxy: ${redactProxyCredentials(proxyEnv)}`);
  warn("    NemoClaw injects NO_PROXY for its own subprocess spawns (loopback hosts,");
  warn("    container-host aliases, and the managed inference hostname inference.local),");
  warn("    but any tool you run that respects HTTP_PROXY (curl, Node fetch, Python");
  warn("    requests) will still tunnel localhost traffic through your host proxy.");
  warn("    To bypass loopback and the managed inference hostname:");
  warn("      export NO_PROXY=localhost,127.0.0.1,inference.local");
  warn("      export no_proxy=localhost,127.0.0.1,inference.local");
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
