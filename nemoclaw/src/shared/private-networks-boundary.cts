// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { BlockList, isIP } from "node:net";

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

export interface PrivateNetworkMatcher {
  blockList: BlockList;
  isPrivateIp(address: string): boolean;
  isPrivateHostname(hostname: string): boolean;
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
  const { address, prefix, purpose } = record;
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
  const { name, purpose } = record;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${where}: missing or empty 'name'`);
  }
  if (name !== name.trim() || name.replace(/\.$/, "").length === 0) {
    throw new Error(`${where}: 'name' must be canonical and contain no surrounding whitespace`);
  }
  if (typeof purpose !== "string" || purpose.trim().length === 0) {
    throw new Error(
      `${where}: 'purpose' must be a non-empty string so reviewers can judge the block`,
    );
  }
  return { name, purpose };
}

export function parsePrivateNetworkDocument(raw: string, source: string): NetworkDocument {
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
    ipv4: parsed.ipv4.map((entry, index) => validateNetworkEntry(entry, "ipv4", index, source)),
    ipv6: parsed.ipv6.map((entry, index) => validateNetworkEntry(entry, "ipv6", index, source)),
    names: parsed.names.map((entry, index) => validateNameEntry(entry, index, source)),
  };
}

export function createPrivateNetworkMatcher(networks: NetworkDocument): PrivateNetworkMatcher {
  const blockList = new BlockList();
  for (const { address, prefix } of networks.ipv4) blockList.addSubnet(address, prefix, "ipv4");
  for (const { address, prefix } of networks.ipv6) blockList.addSubnet(address, prefix, "ipv6");
  const normalisedNames = networks.names.map((entry) =>
    entry.name.replace(/\.$/, "").toLowerCase(),
  );

  const isPrivateIp = (address: string): boolean => {
    const family = isIP(address);
    if (family === 0) return false;
    return blockList.check(address, family === 6 ? "ipv6" : "ipv4");
  };

  return {
    blockList,
    isPrivateIp,
    isPrivateHostname(hostname: string): boolean {
      const stripped =
        hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
      const normalised = stripped.replace(/\.$/, "").toLowerCase();
      for (const reserved of normalisedNames) {
        if (normalised === reserved || normalised.endsWith(`.${reserved}`)) return true;
      }
      return isPrivateIp(normalised);
    },
  };
}
