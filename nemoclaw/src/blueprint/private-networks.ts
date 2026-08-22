// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Private-network block list for SSRF validation. Loads the canonical
// CIDR set from nemoclaw-blueprint/private-networks.yaml and builds a
// node:net BlockList on first use, then memoises until the YAML file
// source or stats (mtime/size) change. Pure parsing and matching live in
// the shared private-network boundary.
//
// Path resolution mirrors loadBlueprint() in runner.ts: honour
// NEMOCLAW_BLUEPRINT_PATH when set, otherwise try the dev-checkout
// location relative to this module, otherwise fall back to the current
// directory. In a published plugin install the relative guess does not
// exist, so NEMOCLAW_BLUEPRINT_PATH (set by the CLI launcher) or a
// cwd-located blueprint is required at runtime.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as importedPrivateNetworkBoundary from "../shared/private-networks-boundary.cjs";
import type {
  NetworkDocument,
  PrivateNetworkMatcher,
} from "../shared/private-networks-boundary.cjs";

export type {
  NameEntry,
  NetworkDocument,
  NetworkEntry,
} from "../shared/private-networks-boundary.cjs";

// The generated module exposes named CommonJS exports. Source-mode tsx maps
// the .cjs specifier to .cts and exposes the same module as its default.
const sourceOrGeneratedPrivateNetworkBoundary =
  importedPrivateNetworkBoundary as typeof importedPrivateNetworkBoundary & {
    default?: typeof importedPrivateNetworkBoundary;
  };
const { createPrivateNetworkMatcher, parsePrivateNetworkDocument } =
  sourceOrGeneratedPrivateNetworkBoundary.default ?? sourceOrGeneratedPrivateNetworkBoundary;

interface LoadedNetworks {
  source: string;
  mtimeMs: number;
  size: number;
  checkedAtMs: number;
  networks: NetworkDocument;
  matcher: PrivateNetworkMatcher;
}

// Keep hot SSRF checks in memory while still letting long-running plugin
// processes pick up private-network updates without a restart.
const STAT_CHECK_INTERVAL_MS = 1_000;

let cached: LoadedNetworks | null = null;

function missingPrivateNetworksError(source: string): Error {
  return new Error(
    `private-networks.yaml not found at ${source}. ` +
      `Set NEMOCLAW_BLUEPRINT_PATH to the directory containing the blueprint, ` +
      `or run from a checkout that includes nemoclaw-blueprint/.`,
  );
}

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

function isNodeEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function readPrivateNetworksFile(source: string): string {
  try {
    return readFileSync(source, "utf-8");
  } catch (err) {
    if (isNodeEnoent(err)) throw missingPrivateNetworksError(source);
    throw err;
  }
}

function load(): LoadedNetworks {
  const now = Date.now();
  if (cached && now - cached.checkedAtMs < STAT_CHECK_INTERVAL_MS) return cached;

  const source = join(resolveBlueprintPath(), "private-networks.yaml");
  let mtimeMs: number;
  let size: number;
  try {
    const stat = statSync(source);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch (err) {
    if (isNodeEnoent(err)) throw missingPrivateNetworksError(source);
    throw err;
  }
  if (cached && cached.source === source && cached.mtimeMs === mtimeMs && cached.size === size) {
    cached.checkedAtMs = now;
    return cached;
  }
  const networks = parsePrivateNetworkDocument(readPrivateNetworksFile(source), source);
  cached = {
    source,
    mtimeMs,
    size,
    checkedAtMs: now,
    networks,
    matcher: createPrivateNetworkMatcher(networks),
  };
  return cached;
}

export function getPrivateNetworks(): PrivateNetworkMatcher["blockList"] {
  return load().matcher.blockList;
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
