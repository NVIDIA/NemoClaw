// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Private-network block list for SSRF validation. Loads the canonical
// CIDR set from nemoclaw-blueprint/private-networks.yaml and builds a
// node:net BlockList on first use, then memoises. Pure parsing and
// matching live in the shared private-network boundary.

import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

import {
  createPrivateNetworkMatcher,
  parsePrivateNetworkDocument,
} from "../../nemoclaw/dist/shared/private-networks-boundary.cjs";
import type {
  NetworkDocument,
  PrivateNetworkMatcher,
} from "../../nemoclaw/dist/shared/private-networks-boundary.cjs";

import { ROOT } from "./runner";

const NETWORKS_FILE = path.join(ROOT, "nemoclaw-blueprint", "private-networks.yaml");

export const OPENSHELL_SANDBOX_HOST_BRIDGE = "host.openshell.internal";

export type {
  NameEntry,
  NetworkDocument,
  NetworkEntry,
} from "../../nemoclaw/dist/shared/private-networks-boundary.cjs";

interface LoadedNetworks {
  networks: NetworkDocument;
  matcher: PrivateNetworkMatcher;
}

let cached: LoadedNetworks | null = null;

function load(): LoadedNetworks {
  if (cached) return cached;
  if (!fs.existsSync(NETWORKS_FILE)) {
    throw new Error(
      `private-networks.yaml not found at ${NETWORKS_FILE}. ` +
        `The CLI resolves this path relative to the compiled project root, ` +
        `so the checkout must include nemoclaw-blueprint/private-networks.yaml ` +
        `(the plugin has a separate NEMOCLAW_BLUEPRINT_PATH override).`,
    );
  }
  const networks = parsePrivateNetworkDocument(
    fs.readFileSync(NETWORKS_FILE, "utf-8"),
    NETWORKS_FILE,
  );
  cached = { networks, matcher: createPrivateNetworkMatcher(networks) };
  return cached;
}

export function getPrivateNetworks(): PrivateNetworkMatcher["blockList"] {
  return load().matcher.blockList;
}

export function getNetworkEntries(): NetworkDocument {
  return load().networks;
}

export function resetCache(): void {
  cached = null;
}

/**
 * Return true when `address` is a bare IPv4 or IPv6 literal inside any
 * private/reserved/translation range in the shared YAML.
 *
 * Input must be a bare IP literal — brackets are URL syntax, not IP
 * syntax, and are handled by isPrivateHostname instead. Intended for
 * callers that already have a resolved IP address, e.g. after a DNS
 * lookup in validateEndpointUrl.
 *
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are auto-matched against
 * IPv4 rules by node:net BlockList, so no explicit handling is needed.
 * NAT64, 6to4, and IETF special-purpose prefixes are blocked by prefix in the YAML
 * because BlockList does not extract embedded IPv4 from those forms.
 */
export function isPrivateIp(address: string): boolean {
  return load().matcher.isPrivateIp(address);
}

/**
 * Return true when `hostname` is either (a) a reserved private/internal
 * name from the `names` list in the shared YAML (matching bare label or
 * any subdomain, case-insensitive, trailing-FQDN-dot normalised), or
 * (b) an IP literal in any form that URL.hostname can emit — bare IPv4
 * or bracketed IPv6 — inside a range covered by isPrivateIp.
 *
 * Intended for user-input boundaries (e.g. `nemoclaw config set`) where
 * the value is a URL.hostname and may be a name, an IPv4 literal, or a
 * `[::1]`-style bracketed IPv6 literal. Post-DNS call sites should use
 * the narrower isPrivateIp.
 */
export function isPrivateHostname(hostname: string): boolean {
  return load().matcher.isPrivateHostname(hostname);
}

export function isAllowedOpenShellSandboxBridgeUrl(url: URL): boolean {
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  const port = Number(url.port);
  return (
    hostname.replace(/\.$/, "").toLowerCase() === OPENSHELL_SANDBOX_HOST_BRIDGE &&
    url.protocol === "http:" &&
    Number.isInteger(port) &&
    port >= 1024 &&
    port <= 65535 &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

/**
 * Return true when `hostname` is an IPv4/IPv6 loopback literal (127.0.0.0/8 or
 * ::1) or the RFC 6761 `localhost` special-use name.
 *
 * Loopback is a proper subset of what isPrivateHostname matches, but it is
 * semantically distinct for SSRF purposes: a loopback address only ever reaches
 * a service on the probing host itself, so it is not a pivot to other internal
 * infrastructure the way LAN ranges (10/8, 192.168/16) or link-local metadata
 * (169.254.169.254) are. Host-side onboarding probes for locally-run inference
 * servers (Ollama on 127.0.0.1, vLLM on localhost) legitimately target it, so
 * callers that must still refuse genuine private-network SSRF can exempt
 * loopback specifically without weakening the LAN/metadata blocks.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const stripped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const normalised = stripped.replace(/\.$/, "").toLowerCase();
  if (normalised === "localhost") return true;
  const family = isIP(normalised);
  if (family === 4) return normalised.startsWith("127.");
  if (family === 6) return normalised === "::1";
  return false;
}
