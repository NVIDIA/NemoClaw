// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Private-network block list for SSRF validation. Loads the canonical
// CIDR set from nemoclaw-blueprint/private-networks.yaml and builds a
// node:net BlockList on first use, then memoises. The CLI has an
// equivalent module at src/lib/private-networks.ts; the parity test at
// test/ssrf-parity.test.ts verifies both produce identical results.
//
// Path resolution mirrors loadBlueprint() in runner.ts: honour
// NEMOCLAW_BLUEPRINT_PATH when set, otherwise try the dev-checkout
// location relative to this module, otherwise fall back to the current
// directory. In a published plugin install the relative guess does not
// exist, so NEMOCLAW_BLUEPRINT_PATH (set by the CLI launcher) or a
// cwd-located blueprint is required at runtime.

import { existsSync, readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

export interface NetworkEntry {
  address: string;
  prefix: number;
  purpose: string;
}

export interface NameEntry {
  name: string;
  purpose: string;
}

export interface NetworkDocument {
  ipv4: NetworkEntry[];
  ipv6: NetworkEntry[];
  names: NameEntry[];
}

interface LoadedNetworks {
  networks: NetworkDocument;
  blockList: BlockList;
  normalisedNames: string[];
}

let cached: LoadedNetworks | null = null;

function resolveBlueprintPath(): string {
  const fromEnv = process.env.NEMOCLAW_BLUEPRINT_PATH;
  if (fromEnv) return fromEnv;
  const here = dirname(fileURLToPath(import.meta.url));
  const devGuess = join(here, "..", "..", "..", "nemoclaw-blueprint");
  // Check for the YAML file specifically so a stale directory without
  // the expected file falls through to cwd instead of a read failure.
  if (existsSync(join(devGuess, "private-networks.yaml"))) return devGuess;
  return ".";
}

function validateNetworkEntry(
  entry: unknown,
  family: "ipv4" | "ipv6",
  index: number,
  source: string,
): NetworkEntry {
  const where = `${source}: ${family}[${String(index)}]`;
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`${where}: expected an object`);
  }
  const record = entry as Record<string, unknown>;
  const address = record.address;
  const prefix = record.prefix;
  const purpose = record.purpose;
  if (typeof address !== "string" || address.length === 0) {
    throw new Error(`${where}: missing or empty 'address'`);
  }
  const expectedFamily = family === "ipv4" ? 4 : 6;
  if (isIP(address) !== expectedFamily) {
    throw new Error(
      `${where}: 'address' must be a valid ${family} literal, got ${JSON.stringify(address)}`,
    );
  }
  const maxPrefix = family === "ipv4" ? 32 : 128;
  if (typeof prefix !== "number" || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(
      `${where}: 'prefix' must be an integer in [0, ${String(maxPrefix)}], got ${JSON.stringify(prefix)}`,
    );
  }
  if (typeof purpose !== "string" || purpose.trim().length === 0) {
    throw new Error(
      `${where}: 'purpose' must be a non-empty string so reviewers can judge the block`,
    );
  }
  return { address, prefix, purpose };
}

function validateNameEntry(entry: unknown, index: number, source: string): NameEntry {
  const where = `${source}: names[${String(index)}]`;
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`${where}: expected an object`);
  }
  const record = entry as Record<string, unknown>;
  const name = record.name;
  const purpose = record.purpose;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${where}: missing or empty 'name'`);
  }
  if (typeof purpose !== "string" || purpose.trim().length === 0) {
    throw new Error(
      `${where}: 'purpose' must be a non-empty string so reviewers can judge the block`,
    );
  }
  return { name, purpose };
}

function parseDocument(raw: string, source: string): NetworkDocument {
  const parsed = YAML.parse(raw) as Record<string, unknown> | null;
  if (
    !parsed ||
    !Array.isArray(parsed.ipv4) ||
    !Array.isArray(parsed.ipv6) ||
    !Array.isArray(parsed.names)
  ) {
    throw new Error(`${source}: expected top-level 'ipv4', 'ipv6', and 'names' arrays`);
  }
  return {
    ipv4: parsed.ipv4.map((entry, i) => validateNetworkEntry(entry, "ipv4", i, source)),
    ipv6: parsed.ipv6.map((entry, i) => validateNetworkEntry(entry, "ipv6", i, source)),
    names: parsed.names.map((entry, i) => validateNameEntry(entry, i, source)),
  };
}

function load(): LoadedNetworks {
  if (cached) return cached;
  const source = join(resolveBlueprintPath(), "private-networks.yaml");
  if (!existsSync(source)) {
    throw new Error(
      `private-networks.yaml not found at ${source}. ` +
        `Set NEMOCLAW_BLUEPRINT_PATH to the directory containing the blueprint, ` +
        `or run from a checkout that includes nemoclaw-blueprint/.`,
    );
  }
  const networks = parseDocument(readFileSync(source, "utf-8"), source);
  const blockList = new BlockList();
  for (const { address, prefix } of networks.ipv4) blockList.addSubnet(address, prefix, "ipv4");
  for (const { address, prefix } of networks.ipv6) blockList.addSubnet(address, prefix, "ipv6");
  const normalisedNames = networks.names.map((e) => e.name.replace(/\.$/, "").toLowerCase());
  cached = { networks, blockList, normalisedNames };
  return cached;
}

export function getPrivateNetworks(): BlockList {
  return load().blockList;
}

export function getNetworkEntries(): NetworkDocument {
  return load().networks;
}

// Exposed for tests that need to re-read the file after changing the
// environment or mocked fs contents.
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
 * NAT64, 6to4, and Teredo prefixes are blocked by prefix in the YAML
 * because BlockList does not extract embedded IPv4 from those forms.
 */
export function isPrivateIp(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return getPrivateNetworks().check(address, family === 6 ? "ipv6" : "ipv4");
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
  // Strip URL IPv6 brackets before any check. Brackets are only legal
  // in URL syntax around IPv6 literals, so stripping them is safe for
  // both the name-level and IP-literal checks below.
  const stripped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const normalised = stripped.replace(/\.$/, "").toLowerCase();
  const { normalisedNames } = load();
  for (const reserved of normalisedNames) {
    if (normalised === reserved || normalised.endsWith(`.${reserved}`)) return true;
  }
  return isPrivateIp(normalised);
}
