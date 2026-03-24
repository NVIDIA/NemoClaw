// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { promises as dnsPromises } from "node:dns";
import { isIPv4, isIPv6 } from "node:net";

interface CidrRange {
  network: Uint8Array;
  prefixLen: number;
}

const PRIVATE_NETWORKS: CidrRange[] = [
  cidr("127.0.0.0", 8),
  cidr("10.0.0.0", 8),
  cidr("172.16.0.0", 12),
  cidr("192.168.0.0", 16),
  cidr("169.254.0.0", 16),
  cidr6("::1", 128),
  cidr6("fd00::", 8),
];

const ALLOWED_SCHEMES = new Set(["https:", "http:"]);

function parseIPv4(addr: string): Uint8Array {
  const parts = addr.split(".");
  return new Uint8Array(parts.map(Number));
}

function parseIPv6(addr: string): Uint8Array {
  // Expand :: notation to full 8 groups
  let groups: string[];
  if (addr.includes("::")) {
    const [left, right] = addr.split("::");
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    groups = [...leftGroups, ...Array<string>(missing).fill("0"), ...rightGroups];
  } else {
    groups = addr.split(":");
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const val = parseInt(groups[i], 16);
    bytes[i * 2] = (val >> 8) & 0xff;
    bytes[i * 2 + 1] = val & 0xff;
  }
  return bytes;
}

function cidr(addr: string, prefixLen: number): CidrRange {
  return { network: parseIPv4(addr), prefixLen };
}

function cidr6(addr: string, prefixLen: number): CidrRange {
  return { network: parseIPv6(addr), prefixLen };
}

function ipInCidr(ipBytes: Uint8Array, range: CidrRange): boolean {
  if (ipBytes.length !== range.network.length) return false;

  const fullBytes = Math.floor(range.prefixLen / 8);
  const remainingBits = range.prefixLen % 8;

  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== range.network[i]) return false;
  }

  if (remainingBits > 0) {
    const mask = 0xff << (8 - remainingBits);
    if ((ipBytes[fullBytes] & mask) !== (range.network[fullBytes] & mask)) return false;
  }

  return true;
}

export function isPrivateIp(addr: string): boolean {
  let ipBytes: Uint8Array;

  if (isIPv4(addr)) {
    ipBytes = parseIPv4(addr);
  } else if (isIPv6(addr)) {
    ipBytes = parseIPv6(addr);
  } else {
    return false;
  }

  return PRIVATE_NETWORKS.some((range) => ipInCidr(ipBytes, range));
}

export async function validateEndpointUrl(url: string): Promise<string> {
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

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsPromises.lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(`Cannot resolve hostname '${hostname}': ${String(err)}`);
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(
        `Endpoint URL resolves to private/internal address ${address}. ` +
          "Connections to internal networks are not allowed.",
      );
    }
  }

  return url;
}
