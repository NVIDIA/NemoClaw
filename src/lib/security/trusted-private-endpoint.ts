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
 * NemoClaw's OpenShell-managed infrastructure hostnames. These resolve to the
 * host loopback or the OpenShell L7 proxy by design (see
 * `subprocess-env` `withLocalNoProxy` and `verify-deployment` for
 * `inference.local`), so — unlike an arbitrary user-supplied public name — they
 * are trusted aliases, not attacker-controlled names subject to DNS rebinding.
 * They are exempt from the public-resolution requirement, like explicit
 * loopback, and connect normally without `--resolve` pinning. This mirrors the
 * MCP URL-target allowlist (`isOpenShellMcpHostAlias`) and also covers
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
    addresses: Object.freeze([...new Set(addresses.map(normalizeIpLiteral))].sort()),
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
  /** Stable failure classification for callers that must not parse `reason`. */
  reasonCode?: "mixed-answer" | "private-answer" | "rejected" | "unresolved";
  /** Exact rejected DNS answer when `reasonCode` identifies an address failure. */
  offendingAddress?: string;
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

function normalizeIpLiteral(address: string): string {
  if (isIP(address) !== 6) return address.toLowerCase();
  const hostname = new URL(`http://[${address}]/`).hostname;
  return hostname.slice(1, -1).toLowerCase();
}

/** Normalize one exact hostname or IP literal for an operator trust decision. */
export function normalizeTrustedPrivateHost(raw: string): string {
  const value = String(raw).trim();
  if (!value) throw new Error("trusted private host must not be empty");

  if (value.startsWith("[") || value.endsWith("]")) {
    if (!(value.startsWith("[") && value.endsWith("]"))) {
      throw new Error(`trusted private host "${value}" is malformed`);
    }
    const address = value.slice(1, -1).toLowerCase();
    if (isIP(address) !== 6) {
      throw new Error(`trusted private host "${value}" is not an IPv6 literal`);
    }
    return normalizeIpLiteral(address);
  }

  if (
    value.includes("://") ||
    /[\\/?#@*]/.test(value) ||
    value.startsWith(".") ||
    value.includes("%")
  ) {
    throw new Error(`trusted private host "${value}" must be an exact hostname or IP literal`);
  }

  const normalized = value.replace(/\.$/, "").toLowerCase();
  if (!normalized || normalized.endsWith(".")) {
    throw new Error(`trusted private host "${value}" is malformed`);
  }
  if (isIP(normalized) !== 0) return normalizeIpLiteral(normalized);
  if (normalized.includes(":")) {
    throw new Error(`trusted private host "${value}" must not include a port`);
  }
  if (/^\d+(?:\.\d+){3}$/.test(normalized)) {
    throw new Error(`trusted private host "${value}" is not a valid IP literal`);
  }
  if (normalized.length > 253) {
    throw new Error(`trusted private host "${value}" is too long`);
  }

  const labels = normalized.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new Error(`trusted private host "${value}" is malformed`);
  }
  return normalized;
}

/** Parse a comma-separated allowlist of exact private endpoint hosts. */
export function parseTrustedPrivateHosts(value: string | undefined): string[] {
  const input = String(value ?? "").trim();
  if (!input) return [];
  return [...new Set(input.split(",").map((entry) => normalizeTrustedPrivateHost(entry)))];
}

export interface TrustedPrivateEndpointReplay {
  readonly host: string;
  readonly addresses: readonly string[];
  readonly trustedPrivateCapability: TrustedPrivateEndpointCapability;
}

/** Reissue in-process capability authority from exact durable private pins. */
export function replayTrustedPrivateEndpoint(
  host: string,
  addresses: readonly string[],
): TrustedPrivateEndpointReplay {
  const normalizedHost = normalizeTrustedPrivateHost(host);
  if (addresses.length === 0) {
    throw new Error(`trusted private host "${normalizedHost}" has no recorded address pins`);
  }
  const normalizedAddresses = addresses.map((address) => {
    if (typeof address !== "string" || !isOperatorTrustablePrivateIp(address)) {
      throw new Error(
        `trusted private host "${normalizedHost}" has a disallowed recorded address pin`,
      );
    }
    return normalizeIpLiteral(address);
  });
  if (new Set(normalizedAddresses).size !== normalizedAddresses.length) {
    throw new Error(`trusted private host "${normalizedHost}" has duplicate recorded address pins`);
  }
  const pinnedAddresses = Object.freeze([...normalizedAddresses].sort());
  return Object.freeze({
    host: normalizedHost,
    addresses: pinnedAddresses,
    trustedPrivateCapability: issueTrustedPrivateEndpointCapability(pinnedAddresses),
  });
}

/**
 * DNS-backed SSRF preflight for a user-supplied endpoint. Callers run this
 * before a privileged host-side request.
 *
 * The string-level `isPrivateHostname` guards elsewhere block literal private
 * IP addresses and reserved names. A public-looking endpoint name can still
 * resolve to `127.0.0.1`, `169.254.169.254`, or RFC1918 space. This resolves the
 * hostname first and rejects a private or reserved address before a host
 * request. It complements the
 * authoritative config-write DNS-pinning boundary (`validateUrlValueWithDnsResult`)
 * which runs later, before the URL is persisted.
 *
 * Loopback (`127.0.0.0/8`, `::1`, and `localhost`) remains exempt only when the
 * endpoint hostname is itself loopback. This preserves local inference
 * behavior. A public name that resolves to loopback is treated as a rebinding
 * attempt and rejected. The check fails closed on a resolver error or empty
 * result.
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
    return {
      ok: false,
      reason: `"${String(endpointUrl)}" is not a valid URL`,
      reasonCode: "rejected",
    };
  }

  // Keep the capability and range helpers import-light for generic curl
  // validation. The YAML-backed private-network classifier is needed only
  // when a caller actually runs the endpoint preflight.
  const { isLoopbackHostname, isPrivateHostname, isPrivateIp } =
    require("../private-networks") as typeof import("../private-networks");

  let normalizedHostname: string;
  let trustedPrivateHosts: string[];
  try {
    normalizedHostname = normalizeTrustedPrivateHost(hostname);
    trustedPrivateHosts = (options.trustedPrivateHosts ?? []).map(normalizeTrustedPrivateHost);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message, reasonCode: "rejected" };
  }
  const trustedPrivateHost = trustedPrivateHosts.includes(normalizedHostname);

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
    return {
      ok: false,
      reason: `endpoint host "${hostname}" is a private/internal address`,
      reasonCode: "rejected",
    };
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
      : {
          ok: false,
          reason: `endpoint host "${hostname}" is a private/internal address`,
          reasonCode: "rejected",
        };
  }

  let addresses: Array<{ address: string; family?: number }>;
  try {
    addresses = await lookup(bare, { all: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `cannot resolve endpoint host "${hostname}": ${message}`,
      reasonCode: "unresolved",
    };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return {
      ok: false,
      reason: `endpoint host "${hostname}" did not resolve to any address`,
      reasonCode: "unresolved",
    };
  }
  for (const { address } of addresses) {
    // A resolved private address — including loopback reached via a public name
    // (DNS rebinding) — is refused; the explicit-loopback case returned above.
    if (isPrivateIp(address) && (!trustedPrivateHost || !isOperatorTrustablePrivateIp(address))) {
      return {
        ok: false,
        reason: `endpoint host "${hostname}" resolves to private/internal address "${address}"`,
        reasonCode: "private-answer",
        offendingAddress: address,
      };
    }
  }
  const resolvedAddresses = addresses.map(({ address }) => address);
  const trustedPrivateAddresses = resolvedAddresses.filter((address) => isPrivateIp(address));
  if (
    trustedPrivateHost &&
    trustedPrivateAddresses.length > 0 &&
    trustedPrivateAddresses.length !== resolvedAddresses.length
  ) {
    const offendingAddress = resolvedAddresses.find(
      (address) => !isOperatorTrustablePrivateIp(address),
    );
    return {
      ok: false,
      reason:
        `endpoint host "${hostname}" resolves to mixed public and private addresses` +
        (offendingAddress ? `, including untrusted answer "${offendingAddress}"` : ""),
      reasonCode: "mixed-answer",
      offendingAddress,
    };
  }
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
