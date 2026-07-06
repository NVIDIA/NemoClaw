// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { isLoopbackHostname, isPrivateHostname, isPrivateIp } from "../private-networks";

/** Injectable DNS resolver, shaped like `dns/promises` `lookup(host, {all:true})`. */
export type EndpointDnsLookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family?: number }>>;

export interface EndpointSsrfPreflightResult {
  ok: boolean;
  /** Human-readable reason, present only when `ok === false`. */
  reason?: string;
}

/**
 * DNS-backed SSRF preflight for a user-supplied inference endpoint, run before
 * any privileged host-side curl during onboarding.
 *
 * The string-level `isPrivateHostname` guards elsewhere block literal private
 * IPs and reserved names, but a public-looking name (`https://vllm.example/v1`)
 * can still resolve to `127.0.0.1`, `169.254.169.254`, or RFC1918 space and make
 * the onboarding host contact internal services before the sandbox and its
 * OpenShell network policy exist. This resolves the hostname first and refuses
 * when it — or any resolved address — is private/reserved. It complements the
 * authoritative config-write DNS-pinning boundary (`validateUrlValueWithDnsResult`)
 * which runs later, before the URL is persisted.
 *
 * Loopback (127.0.0.0/8, ::1, localhost) is exempt ONLY when the endpoint
 * hostname is itself loopback — a locally-run vLLM/Ollama server the user
 * explicitly configured. A public name that *resolves* to loopback is treated
 * as a rebinding attempt and refused. The resolver is injectable for tests and
 * the check fails closed on resolver error or an empty result.
 *
 * See PR #6293 PRA-4 (GPT-5.5 advisor).
 */
export async function assertEndpointResolvesPublic(
  endpointUrl: string,
  lookup: EndpointDnsLookupFn = dnsLookup as unknown as EndpointDnsLookupFn,
): Promise<EndpointSsrfPreflightResult> {
  let hostname: string;
  try {
    hostname = new URL(String(endpointUrl)).hostname;
  } catch {
    return { ok: false, reason: `"${String(endpointUrl)}" is not a valid URL` };
  }

  // An explicit loopback host is a legitimate local inference server.
  if (isLoopbackHostname(hostname)) return { ok: true };

  // A literal private IP or reserved private name is refused without resolving.
  if (isPrivateHostname(hostname)) {
    return { ok: false, reason: `endpoint host "${hostname}" is a private/internal address` };
  }

  // A public IP literal needs no DNS resolution.
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare)) return { ok: true };

  let addresses: Array<{ address: string; family?: number }>;
  try {
    addresses = await lookup(bare, { all: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `cannot resolve endpoint host "${hostname}": ${message}` };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, reason: `endpoint host "${hostname}" did not resolve to any address` };
  }
  for (const { address } of addresses) {
    // A resolved private address — including loopback reached via a public name
    // (DNS rebinding) — is refused; the explicit-loopback case returned above.
    if (isPrivateIp(address)) {
      return {
        ok: false,
        reason: `endpoint host "${hostname}" resolves to private/internal address "${address}"`,
      };
    }
  }
  return { ok: true };
}
