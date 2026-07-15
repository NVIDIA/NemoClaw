// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** Injectable DNS resolver, shaped like `dns/promises` `lookup(host, {all:true})`. */
export type EndpointDnsLookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family?: number }>>;

/**
 * NemoClaw's own OpenShell-managed infrastructure hostnames. These resolve to
 * the host loopback or the OpenShell L7 proxy *by design* (see
 * `subprocess-env` `withLocalNoProxy` and `verify-deployment` for
 * `inference.local`), so — unlike an arbitrary user-supplied public name — they
 * are trusted aliases, not attacker-controlled names subject to DNS rebinding.
 * They are exempt from the public-resolution requirement (like explicit
 * loopback) and connect normally without `--resolve` pinning. This mirrors the
 * MCP URL-target allowlist (`isOpenShellMcpHostAlias`), additionally covering
 * `inference.local` — the managed sandbox inference route a compatible endpoint
 * legitimately targets (#6293).
 */
const OPENSHELL_MANAGED_HOSTS = new Set([
  "inference.local",
  "host.openshell.internal",
  "host.docker.internal",
  "host.containers.internal",
]);

// An explicit operator allowlist may admit routable enterprise/private address
// space, but never link-local metadata, multicast, documentation, translation,
// or other reserved ranges covered by the broader SSRF denylist.
const OPERATOR_TRUSTABLE_PRIVATE_NETWORKS = new BlockList();
OPERATOR_TRUSTABLE_PRIVATE_NETWORKS.addSubnet("10.0.0.0", 8, "ipv4");
OPERATOR_TRUSTABLE_PRIVATE_NETWORKS.addSubnet("100.64.0.0", 10, "ipv4");
OPERATOR_TRUSTABLE_PRIVATE_NETWORKS.addSubnet("172.16.0.0", 12, "ipv4");
OPERATOR_TRUSTABLE_PRIVATE_NETWORKS.addSubnet("192.168.0.0", 16, "ipv4");
OPERATOR_TRUSTABLE_PRIVATE_NETWORKS.addSubnet("fc00::", 7, "ipv6");

declare const trustedPrivateEndpointCapabilityBrand: unique symbol;

/**
 * Ephemeral proof that the shared SSRF preflight admitted an exact set of
 * operator-trusted private addresses. Callers can carry this value, but only
 * this module can issue one and the curl boundary validates its provenance.
 */
export interface TrustedPrivateEndpointCapability {
  readonly addresses: readonly string[];
  readonly [trustedPrivateEndpointCapabilityBrand]: true;
}

const TRUSTED_PRIVATE_ENDPOINT_CAPABILITIES = new WeakSet<object>();

function issueTrustedPrivateEndpointCapability(
  addresses: readonly string[],
): TrustedPrivateEndpointCapability {
  const capability = Object.freeze({
    addresses: Object.freeze([...new Set(addresses)]),
  }) as unknown as TrustedPrivateEndpointCapability;
  TRUSTED_PRIVATE_ENDPOINT_CAPABILITIES.add(capability);
  return capability;
}

/** True only for a capability issued by this module in the current process. */
export function isTrustedPrivateEndpointCapability(
  value: unknown,
): value is TrustedPrivateEndpointCapability {
  return (
    typeof value === "object" && value !== null && TRUSTED_PRIVATE_ENDPOINT_CAPABILITIES.has(value)
  );
}
export function isOperatorTrustablePrivateIp(address: string): boolean {
  const family = isIP(address);
  return (
    family !== 0 &&
    OPERATOR_TRUSTABLE_PRIVATE_NETWORKS.check(address, family === 6 ? "ipv6" : "ipv4")
  );
}

/** True when `hostname` is a NemoClaw OpenShell-managed infrastructure alias. */
export function isOpenShellManagedHost(hostname: string): boolean {
  const normalised = (
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  )
    .replace(/\.$/, "")
    .toLowerCase();
  return OPENSHELL_MANAGED_HOSTS.has(normalised);
}

export interface EndpointSsrfPreflightResult {
  ok: boolean;
  /** Human-readable reason, present only when `ok === false`. */
  reason?: string;
  /**
   * Validated public addresses the endpoint host resolved to, for connection
   * pinning (curl `--resolve`) so a subsequent probe cannot re-resolve the name
   * to a rebound private/internal address (TOCTOU). Present only when
   * `ok === true` and pinning applies — resolved public names and public IP
   * literals. An empty array is the explicit trusted-no-pin capability for
   * loopback, OpenShell-managed aliases, and public IP literals. Callers must
   * preserve it so credentialed probes bypass ambient proxies even when no
   * curl `--resolve` argument is needed.
   */
  addresses?: string[];
  /** Non-forgeable proof of the exact private addresses admitted by the operator allowlist. */
  trustedPrivateCapability?: TrustedPrivateEndpointCapability;
  /** True only when an exact operator allowlist entry admitted a private address. */
  trustedPrivateEndpoint?: true;
}

export interface EndpointSsrfPreflightOptions {
  /** Exact hostnames or IP literals the operator explicitly trusts on a private network. */
  trustedPrivateHosts?: readonly string[];
}

function normalizeEndpointHost(hostname: string): string {
  return (hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname)
    .replace(/\.$/, "")
    .toLowerCase();
}

/** Parse the explicit private-inference hostname allowlist. Wildcards are not supported. */
export function parseTrustedPrivateInferenceHosts(value: string | undefined): string[] {
  return [
    ...new Set(
      String(value ?? "")
        .split(",")
        .map((entry) => normalizeEndpointHost(entry.trim()))
        .filter(Boolean),
    ),
  ];
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
  options: EndpointSsrfPreflightOptions = {},
): Promise<EndpointSsrfPreflightResult> {
  let hostname: string;
  try {
    hostname = new URL(String(endpointUrl)).hostname;
  } catch {
    return { ok: false, reason: `"${String(endpointUrl)}" is not a valid URL` };
  }

  // Keep the capability and range helpers import-light for generic curl
  // validation. The YAML-backed private-network classifier is needed only
  // when a caller actually runs the endpoint preflight.
  const { isLoopbackHostname, isPrivateHostname, isPrivateIp } =
    require("../private-networks") as typeof import("../private-networks");

  const normalizedHostname = normalizeEndpointHost(hostname);
  const trustedPrivateHost = (options.trustedPrivateHosts ?? []).some(
    (candidate) => normalizeEndpointHost(candidate.trim()) === normalizedHostname,
  );

  // An explicit loopback host is a legitimate local inference server.
  if (isLoopbackHostname(hostname)) return { ok: true, addresses: [] };

  // NemoClaw's own OpenShell-managed aliases (inference.local, host.*.internal)
  // resolve to the managed proxy/loopback by design and are trusted, not
  // rebinding surfaces. Exempt like loopback — connect normally (no pinning) —
  // and exempt BEFORE isPrivateHostname, which would otherwise reject their
  // reserved .local/.internal suffixes (#6293).
  if (isOpenShellManagedHost(hostname)) return { ok: true, addresses: [] };

  // A literal private IP or reserved private name is refused without resolving.
  if (isPrivateHostname(hostname) && !trustedPrivateHost) {
    return { ok: false, reason: `endpoint host "${hostname}" is a private/internal address` };
  }

  // A public IP literal needs neither DNS resolution nor connection pinning:
  // the URL already contains the address curl will connect to.
  const bare = normalizedHostname;
  if (isIP(bare)) {
    if (!isPrivateIp(bare)) return { ok: true, addresses: [] };
    return trustedPrivateHost && isOperatorTrustablePrivateIp(bare)
      ? {
          ok: true,
          addresses: [],
          trustedPrivateCapability: issueTrustedPrivateEndpointCapability([bare]),
          trustedPrivateEndpoint: true,
        }
      : { ok: false, reason: `endpoint host "${hostname}" is a private/internal address` };
  }

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
    if (isPrivateIp(address) && (!trustedPrivateHost || !isOperatorTrustablePrivateIp(address))) {
      return {
        ok: false,
        reason: `endpoint host "${hostname}" resolves to private/internal address "${address}"`,
      };
    }
  }
  const resolvedAddresses = addresses.map(({ address }) => address);
  const trustedPrivateAddresses = resolvedAddresses.filter((address) => isPrivateIp(address));
  return trustedPrivateHost && trustedPrivateAddresses.length > 0
    ? {
        ok: true,
        addresses: resolvedAddresses,
        trustedPrivateCapability: issueTrustedPrivateEndpointCapability(trustedPrivateAddresses),
        trustedPrivateEndpoint: true,
      }
    : { ok: true, addresses: resolvedAddresses };
}

/**
 * Build curl `--resolve <host>:<port>:<addr>` arguments that pin a probe's
 * connection to the address(es) `assertEndpointResolvesPublic` already
 * validated, while leaving the request URL (and therefore its Host header / TLS
 * SNI) untouched. This closes the DNS-rebinding / TOCTOU window between the SSRF
 * preflight and the privileged host-side probe curl: without pinning, curl would
 * re-resolve the hostname and a second lookup could return a rebound
 * private/internal address after the public preflight passed (cv review, #6293).
 *
 * `host` is the URL hostname (IPv6 brackets stripped, as curl `--resolve`
 * expects a bare address); `port` is the explicit URL port or the scheme default
 * (443 for https, 80 for http). Returns `[]` when there are no pinned addresses
 * (explicit-loopback endpoints, or callers that never ran the preflight) so the
 * probe connects normally, and `[]` on an unparseable URL.
 */
export function buildResolvePinArgs(
  targetUrl: string,
  pinnedAddresses?: readonly string[] | null,
): string[] {
  if (!pinnedAddresses || pinnedAddresses.length === 0) return [];
  let host: string;
  let port: string;
  try {
    const url = new URL(String(targetUrl));
    host =
      url.hostname.startsWith("[") && url.hostname.endsWith("]")
        ? url.hostname.slice(1, -1)
        : url.hostname;
    port = url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return [];
  }
  if (!host) return [];
  const addresses = [...new Set(pinnedAddresses.filter(Boolean))];
  if (addresses.length === 0) return [];
  // One --resolve entry preserves every accepted address. Repeating the same
  // host:port entry makes curl retain only the last mapping, silently dropping
  // dual-stack/failover addresses. Bracket IPv6 addresses in the comma list so
  // curl can distinguish their colons from the host:port separators.
  const encodedAddresses = addresses.map((address) =>
    address.includes(":") ? `[${address}]` : address,
  );
  return ["--resolve", `${host}:${port}:${encodedAddresses.join(",")}`];
}
