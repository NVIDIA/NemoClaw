// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Parity guard for SSRF block lists. The CLI
// (src/lib/private-networks.ts) and the plugin
// (nemoclaw/src/blueprint/private-networks.ts) both load their rules
// from the shared nemoclaw-blueprint/private-networks.yaml, so a single
// data edit propagates to both. This test enforces:
//
//   1. Every entry in the YAML ships with a non-empty `purpose` field
//      so no block lands without a human-reviewable rationale.
//   2. The CLI and plugin `isPrivateHostname` implementations agree on a
//      vector per CIDR covering the start of the range, the end, two
//      middle points, one address below the start, and one above the
//      end. Boundary-outside expectations account for adjacent ranges
//      (e.g., 224.0.0.0/4 meeting 240.0.0.0/4, where the neighbour is
//      itself blocked).
//   3. Wrapper-level cases are covered separately: bracketed IPv6,
//      IPv4-mapped IPv6 auto-match, `localhost`, bare DNS names, and
//      garbage input.
//
// Build must run before this test: `npm run build:cli` for the CLI side
// and `npm run build` inside nemoclaw/ for the plugin side.

import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";

const require = createRequire(import.meta.url);

interface NetworkEntry {
  address: string;
  prefix: number;
  purpose: string;
}

interface NameEntry {
  name: string;
  purpose: string;
}

interface NetworkHelper {
  getNetworkEntries(): { ipv4: NetworkEntry[]; ipv6: NetworkEntry[]; names: NameEntry[] };
  isPrivateHostname(hostname: string): boolean;
}

function loadHelper(modulePath: string, buildHint: string): NetworkHelper {
  try {
    return require(modulePath) as NetworkHelper;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === "MODULE_NOT_FOUND") {
      throw new Error(
        `ssrf-parity.test.ts could not load '${modulePath}'. ` +
          `Run ${buildHint} first so the dist/ artifact exists.`,
        { cause: error },
      );
    }
    throw error;
  }
}

const cliHelper = loadHelper("../dist/lib/private-networks", "`npm run build:cli`");
const pluginHelper = loadHelper(
  "../nemoclaw/dist/blueprint/private-networks.js",
  "`npm run build` inside nemoclaw/",
);

function entryLabel(entry: NetworkEntry | NameEntry): string {
  return "address" in entry ? `${entry.address}/${String(entry.prefix)}` : entry.name;
}

// ── Schema checks ───────────────────────────────────────────────────

describe("private-networks.yaml schema", () => {
  it("produces matching entry counts on the CLI and plugin sides", () => {
    const cli = cliHelper.getNetworkEntries();
    const plugin = pluginHelper.getNetworkEntries();
    expect(cli.ipv4.length).toBe(plugin.ipv4.length);
    expect(cli.ipv6.length).toBe(plugin.ipv6.length);
    expect(cli.names.length).toBe(plugin.names.length);
  });

  it("produces identical CIDRs and names on the CLI and plugin sides", () => {
    const fingerprint = (doc: ReturnType<NetworkHelper["getNetworkEntries"]>): string[] => [
      ...doc.ipv4.map((e) => `cidr:${e.address}/${String(e.prefix)}`),
      ...doc.ipv6.map((e) => `cidr:${e.address}/${String(e.prefix)}`),
      ...doc.names.map((e) => `name:${e.name}`),
    ];
    expect(fingerprint(cliHelper.getNetworkEntries())).toEqual(fingerprint(pluginHelper.getNetworkEntries()));
  });

  it("requires a non-empty purpose on every entry", () => {
    const doc = cliHelper.getNetworkEntries();
    for (const family of ["ipv4", "ipv6", "names"] as const) {
      for (const entry of doc[family]) {
        expect(entry.purpose, `${family} ${entryLabel(entry)}`).toBeTypeOf("string");
        expect(entry.purpose.trim().length, `${family} ${entryLabel(entry)}`).toBeGreaterThan(0);
      }
    }
  });

  it("rejects duplicate entries", () => {
    const doc = cliHelper.getNetworkEntries();
    const keys = [
      ...doc.ipv4.map((e) => `cidr:${e.address}/${String(e.prefix)}`),
      ...doc.ipv6.map((e) => `cidr:${e.address}/${String(e.prefix)}`),
      // Normalise exactly like runtime (strip trailing dot, lowercase)
      // so `localhost` and `localhost.` collapse to the same key and
      // cannot slip past as "different" entries.
      ...doc.names.map((e) => `name:${e.name.replace(/\.$/, "").toLowerCase()}`),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ── Boundary parity ─────────────────────────────────────────────────
//
// Per CIDR: start, end, two middles (quarter and three-quarter of the
// range), one address below the start (where defined), one above the
// end (where defined). Outside-boundary expectations set to `true`
// where the neighbour happens to live in another blocked range.

describe("CLI and plugin isPrivateHostname agree on every CIDR boundary", () => {
  const vectors: [string, boolean, string][] = [
    // 0.0.0.0/8 — This network
    ["0.0.0.0", true, "0.0.0.0/8 start"],
    ["0.255.255.255", true, "0.0.0.0/8 end"],
    ["0.64.0.0", true, "0.0.0.0/8 quarter"],
    ["0.192.0.0", true, "0.0.0.0/8 three-quarter"],
    ["1.0.0.0", false, "0.0.0.0/8 after-end"],
    // 10.0.0.0/8 — Private /8
    ["10.0.0.0", true, "10.0.0.0/8 start"],
    ["10.255.255.255", true, "10.0.0.0/8 end"],
    ["10.64.0.0", true, "10.0.0.0/8 quarter"],
    ["10.192.0.0", true, "10.0.0.0/8 three-quarter"],
    ["9.255.255.255", false, "10.0.0.0/8 before-start"],
    ["11.0.0.0", false, "10.0.0.0/8 after-end"],
    // 100.64.0.0/10 — CGNAT
    ["100.64.0.0", true, "100.64.0.0/10 start"],
    ["100.127.255.255", true, "100.64.0.0/10 end"],
    ["100.80.0.0", true, "100.64.0.0/10 quarter"],
    ["100.112.0.0", true, "100.64.0.0/10 three-quarter"],
    ["100.63.255.255", false, "100.64.0.0/10 before-start"],
    ["100.128.0.0", false, "100.64.0.0/10 after-end"],
    // 127.0.0.0/8 — Loopback
    ["127.0.0.0", true, "127.0.0.0/8 start"],
    ["127.255.255.255", true, "127.0.0.0/8 end"],
    ["127.64.0.0", true, "127.0.0.0/8 quarter"],
    ["127.192.0.0", true, "127.0.0.0/8 three-quarter"],
    ["126.255.255.255", false, "127.0.0.0/8 before-start"],
    ["128.0.0.0", false, "127.0.0.0/8 after-end"],
    // 169.254.0.0/16 — Link-local
    ["169.254.0.0", true, "169.254.0.0/16 start"],
    ["169.254.255.255", true, "169.254.0.0/16 end"],
    ["169.254.64.0", true, "169.254.0.0/16 quarter"],
    ["169.254.192.0", true, "169.254.0.0/16 three-quarter"],
    ["169.253.255.255", false, "169.254.0.0/16 before-start"],
    ["169.255.0.0", false, "169.254.0.0/16 after-end"],
    // 172.16.0.0/12 — Private /12
    ["172.16.0.0", true, "172.16.0.0/12 start"],
    ["172.31.255.255", true, "172.16.0.0/12 end"],
    ["172.20.0.0", true, "172.16.0.0/12 quarter"],
    ["172.28.0.0", true, "172.16.0.0/12 three-quarter"],
    ["172.15.255.255", false, "172.16.0.0/12 before-start"],
    ["172.32.0.0", false, "172.16.0.0/12 after-end"],
    // 192.0.0.0/24 — IETF protocol assignments (incl. DS-Lite)
    ["192.0.0.0", true, "192.0.0.0/24 start"],
    ["192.0.0.255", true, "192.0.0.0/24 end"],
    ["192.0.0.64", true, "192.0.0.0/24 quarter"],
    ["192.0.0.192", true, "192.0.0.0/24 three-quarter"],
    ["191.255.255.255", false, "192.0.0.0/24 before-start"],
    ["192.0.1.0", false, "192.0.0.0/24 after-end"],
    // 192.0.2.0/24 — TEST-NET-1
    ["192.0.2.0", true, "192.0.2.0/24 start"],
    ["192.0.2.255", true, "192.0.2.0/24 end"],
    ["192.0.2.64", true, "192.0.2.0/24 quarter"],
    ["192.0.2.192", true, "192.0.2.0/24 three-quarter"],
    ["192.0.1.255", false, "192.0.2.0/24 before-start"],
    ["192.0.3.0", false, "192.0.2.0/24 after-end"],
    // 192.168.0.0/16 — Private /16
    ["192.168.0.0", true, "192.168.0.0/16 start"],
    ["192.168.255.255", true, "192.168.0.0/16 end"],
    ["192.168.64.0", true, "192.168.0.0/16 quarter"],
    ["192.168.192.0", true, "192.168.0.0/16 three-quarter"],
    ["192.167.255.255", false, "192.168.0.0/16 before-start"],
    ["192.169.0.0", false, "192.168.0.0/16 after-end"],
    // 198.18.0.0/15 — Benchmark
    ["198.18.0.0", true, "198.18.0.0/15 start"],
    ["198.19.255.255", true, "198.18.0.0/15 end"],
    ["198.18.128.0", true, "198.18.0.0/15 quarter"],
    ["198.19.128.0", true, "198.18.0.0/15 three-quarter"],
    ["198.17.255.255", false, "198.18.0.0/15 before-start"],
    ["198.20.0.0", false, "198.18.0.0/15 after-end"],
    // 198.51.100.0/24 — TEST-NET-2
    ["198.51.100.0", true, "198.51.100.0/24 start"],
    ["198.51.100.255", true, "198.51.100.0/24 end"],
    ["198.51.100.64", true, "198.51.100.0/24 quarter"],
    ["198.51.100.192", true, "198.51.100.0/24 three-quarter"],
    ["198.51.99.255", false, "198.51.100.0/24 before-start"],
    ["198.51.101.0", false, "198.51.100.0/24 after-end"],
    // 203.0.113.0/24 — TEST-NET-3
    ["203.0.113.0", true, "203.0.113.0/24 start"],
    ["203.0.113.255", true, "203.0.113.0/24 end"],
    ["203.0.113.64", true, "203.0.113.0/24 quarter"],
    ["203.0.113.192", true, "203.0.113.0/24 three-quarter"],
    ["203.0.112.255", false, "203.0.113.0/24 before-start"],
    ["203.0.114.0", false, "203.0.113.0/24 after-end"],
    // 224.0.0.0/4 — Multicast. No after-end vector: 240.0.0.0 is the
    // start of the next block, so an after-end test wouldn't exercise
    // the 224/4 boundary itself.
    ["224.0.0.0", true, "224.0.0.0/4 start"],
    ["239.255.255.255", true, "224.0.0.0/4 end"],
    ["228.0.0.0", true, "224.0.0.0/4 quarter"],
    ["236.0.0.0", true, "224.0.0.0/4 three-quarter"],
    ["223.255.255.255", false, "224.0.0.0/4 before-start"],
    // 240.0.0.0/4 — Reserved for future use (includes broadcast). No
    // before-start vector: 239.255.255.255 is the end of the previous
    // block. No after-end vector: 255.255.255.255 is the end of the
    // IPv4 address space.
    ["240.0.0.0", true, "240.0.0.0/4 start"],
    ["255.255.255.255", true, "240.0.0.0/4 end (limited broadcast)"],
    ["244.0.0.0", true, "240.0.0.0/4 quarter"],
    ["252.0.0.0", true, "240.0.0.0/4 three-quarter"],
    // ::/128 — Unspecified. No before-start (0 is the minimum IPv6
    // address). No after-end vector: ::1 is the next blocked CIDR.
    ["::", true, "::/128 start"],
    // ::1/128 — Loopback. No before-start vector: :: is the start of
    // the previous block.
    ["::1", true, "::1/128 start"],
    ["::2", false, "::1/128 after-end"],
    // 64:ff9b::/96 — NAT64 well-known
    ["64:ff9b::", true, "64:ff9b::/96 start"],
    ["64:ff9b::ffff:ffff", true, "64:ff9b::/96 end"],
    ["64:ff9b::4000:0", true, "64:ff9b::/96 quarter"],
    ["64:ff9b::c000:0", true, "64:ff9b::/96 three-quarter"],
    ["64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff", false, "64:ff9b::/96 before-start"],
    ["64:ff9b:0:0:0:1:0:0", false, "64:ff9b::/96 after-end"],
    // 64:ff9b:1::/48 — NAT64 local-use
    ["64:ff9b:1::", true, "64:ff9b:1::/48 start"],
    ["64:ff9b:1:ffff:ffff:ffff:ffff:ffff", true, "64:ff9b:1::/48 end"],
    ["64:ff9b:1:4000::", true, "64:ff9b:1::/48 quarter"],
    ["64:ff9b:1:c000::", true, "64:ff9b:1::/48 three-quarter"],
    ["64:ff9b:0:ffff:ffff:ffff:ffff:ffff", false, "64:ff9b:1::/48 before-start"],
    ["64:ff9b:2::", false, "64:ff9b:1::/48 after-end"],
    // 100::/64 — Discard prefix
    ["100::", true, "100::/64 start"],
    ["100::ffff:ffff:ffff:ffff", true, "100::/64 end"],
    ["100::4000:0:0:0", true, "100::/64 quarter"],
    ["100::c000:0:0:0", true, "100::/64 three-quarter"],
    ["ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false, "100::/64 before-start"],
    ["100:0:0:1::", false, "100::/64 after-end"],
    // 2001::/32 — Teredo
    ["2001::", true, "2001::/32 start"],
    ["2001:0:ffff:ffff:ffff:ffff:ffff:ffff", true, "2001::/32 end"],
    ["2001:0:4000::", true, "2001::/32 quarter"],
    ["2001:0:c000::", true, "2001::/32 three-quarter"],
    ["2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false, "2001::/32 before-start"],
    ["2001:1::", false, "2001::/32 after-end"],
    // 2001:db8::/32 — Documentation
    ["2001:db8::", true, "2001:db8::/32 start"],
    ["2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", true, "2001:db8::/32 end"],
    ["2001:db8:4000::", true, "2001:db8::/32 quarter"],
    ["2001:db8:c000::", true, "2001:db8::/32 three-quarter"],
    ["2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", false, "2001:db8::/32 before-start"],
    ["2001:db9::", false, "2001:db8::/32 after-end"],
    // 2002::/16 — 6to4
    ["2002::", true, "2002::/16 start"],
    ["2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true, "2002::/16 end"],
    ["2002:4000::", true, "2002::/16 quarter"],
    ["2002:c000::", true, "2002::/16 three-quarter"],
    ["2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false, "2002::/16 before-start"],
    ["2003::", false, "2002::/16 after-end"],
    // fc00::/7 — Unique local
    ["fc00::", true, "fc00::/7 start"],
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true, "fc00::/7 end"],
    ["fc80::", true, "fc00::/7 quarter"],
    ["fd80::", true, "fc00::/7 three-quarter"],
    ["fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false, "fc00::/7 before-start"],
    ["fe00::", false, "fc00::/7 after-end"],
    // fe80::/10 — Link-local
    ["fe80::", true, "fe80::/10 start"],
    ["febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true, "fe80::/10 end"],
    ["fe90::", true, "fe80::/10 quarter"],
    ["feb0::", true, "fe80::/10 three-quarter"],
    ["fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false, "fe80::/10 before-start"],
    ["fec0::", false, "fe80::/10 after-end"],
    // ff00::/8 — Multicast
    ["ff00::", true, "ff00::/8 start"],
    ["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true, "ff00::/8 end"],
    ["ff40::", true, "ff00::/8 quarter"],
    ["ffc0::", true, "ff00::/8 three-quarter"],
    ["feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false, "ff00::/8 before-start"],
  ];

  for (const [addr, expected, label] of vectors) {
    it(`${label}: ${addr} → ${String(expected)}`, () => {
      expect(pluginHelper.isPrivateHostname(addr)).toBe(expected);
      expect(cliHelper.isPrivateHostname(addr)).toBe(expected);
    });
  }
});

// ── Wrapper-level cases (bracket handling, cross-family, DNS) ───────

describe("CLI and plugin isPrivateHostname agree on wrapper-level cases", () => {
  const extras: [string, boolean, string][] = [
    ["[::1]", true, "bracketed IPv6 loopback"],
    ["[fe80::1]", true, "bracketed link-local"],
    ["[2606:4700::1]", false, "bracketed public IPv6"],
    ["::ffff:10.0.0.1", true, "IPv4-mapped private"],
    ["::ffff:127.0.0.1", true, "IPv4-mapped loopback"],
    ["::ffff:100.64.0.1", true, "IPv4-mapped CGNAT"],
    ["::ffff:8.8.8.8", false, "IPv4-mapped public"],
    ["localhost", true, "hostname localhost (RFC 6761)"],
    ["localhost.", true, "localhost with trailing dot (FQDN form)"],
    ["LOCALHOST", true, "localhost uppercase"],
    ["foo.localhost", true, "*.localhost subdomain"],
    ["my-dev.localhost.", true, "*.localhost with trailing dot"],
    ["FOO.LOCALHOST", true, "*.localhost uppercase"],
    ["notlocalhost", false, "hostname containing 'localhost' without dot"],
    ["localhost.com", false, "hostname with 'localhost.' prefix (not the TLD)"],
    ["printer.local", true, "RFC 6762 mDNS .local"],
    ["PRINTER.LOCAL.", true, "mDNS .local uppercase with trailing dot"],
    ["my-vm.c.my-project.internal", true, "ICANN-reserved .internal subdomain"],
    ["local.example.com", false, "'.local' as a non-final label"],
    ["internal.example.com", false, "'.internal' as a non-final label"],
    ["example.com", false, "DNS name"],
    ["not-an-ip", false, "garbage"],
    ["", false, "empty"],
  ];

  for (const [addr, expected, label] of extras) {
    it(`${label}: ${JSON.stringify(addr)} → ${String(expected)}`, () => {
      expect(pluginHelper.isPrivateHostname(addr)).toBe(expected);
      expect(cliHelper.isPrivateHostname(addr)).toBe(expected);
    });
  }
});
