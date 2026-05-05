// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";

import { isPrivateIp, isPrivateHostname } from "./private-networks.js";

// Re-export so consumers can pick the narrower IP-only check (for
// post-DNS addresses) or the broader name-aware check (for user input).
export { isPrivateIp, isPrivateHostname };

const ALLOWED_SCHEMES = new Set(["https:", "http:"]);

function hostnameForDnsLookup(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Result of endpoint URL validation with DNS pinning.
 *
 * `url` is the original URL (hostname intact).
 * `pinnedUrl` has the hostname replaced with the first resolved IP, preventing
 * DNS rebinding TOCTOU attacks where an attacker returns a public IP at
 * validation time and a private IP at connection time.
 *
 * Callers should use `pinnedUrl` for HTTP endpoints (full protection) and `url`
 * for HTTPS endpoints (TLS certificate validation prevents rebinding since the
 * attacker cannot present a valid cert for the rebinding target).
 */
export interface ValidatedEndpoint {
  url: string;
  pinnedUrl: string;
}

export async function validateEndpointUrl(url: string): Promise<ValidatedEndpoint> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`No hostname found in URL: ${url}`);
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    const scheme = parsed.protocol.replace(":", "");
    throw new Error(
      `Unsupported URL scheme '${scheme}://'. Only ${[...ALLOWED_SCHEMES].map((s) => s.replace(":", "://")).join(", ")} are allowed.`,
    );
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new Error(`No hostname found in URL: ${url}`);
  }
  if (isPrivateHostname(hostname)) {
    throw new Error(
      `Endpoint URL points to private/internal address ${hostname}. ` +
        "Connections to internal networks are not allowed.",
    );
  }

  const lookupHostname = hostnameForDnsLookup(hostname);
  if (isIP(lookupHostname)) {
    return { url, pinnedUrl: url };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsPromises.lookup(lookupHostname, { all: true });
  } catch (err) {
    throw new Error(`Cannot resolve hostname '${hostname}': ${String(err)}`);
  }
  if (addresses.length === 0) {
    throw new Error(`Cannot resolve hostname '${hostname}': no addresses returned.`);
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(
        `Endpoint URL resolves to private/internal address ${address}. ` +
          "Connections to internal networks are not allowed.",
      );
    }
  }

  // DNS pinning: replace hostname with the first validated IP to prevent
  // TOCTOU rebinding between validation and connection time.
  const pinned = new URL(url);
  const first = addresses[0];
  pinned.hostname = first.family === 6 ? `[${first.address}]` : first.address;

  return { url, pinnedUrl: pinned.toString() };
}
