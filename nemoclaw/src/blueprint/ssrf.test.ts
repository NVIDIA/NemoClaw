// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for SSRF validation (PSIRT bug 6002763).

import { describe, it, expect, vi } from "vitest";

type LookupResult = Array<{ address: string; family: number }>;
const mockLookup = vi.fn<(hostname: string, options: { all: true }) => Promise<LookupResult>>();

vi.mock("node:dns", () => ({
  promises: { lookup: (...args: unknown[]) => mockLookup(...(args as [string, { all: true }])) },
}));

const { isPrivateIp, validateEndpointUrl } = await import("./ssrf.js");

// ── isPrivateIp ─────────────────────────────────────────────────

describe("isPrivateIp", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "169.254.0.1",
    "169.254.255.255",
    "::1",
    "fd00::1",
    "fdff::1",
    "::ffff:127.0.0.1", // IPv4-mapped IPv6 — localhost
    "::ffff:10.0.0.1", // IPv4-mapped IPv6 — private 10/8
    "::ffff:192.168.1.1", // IPv4-mapped IPv6 — private 192.168/16
    "::ffff:172.16.0.1", // IPv4-mapped IPv6 — private 172.16/12
    "100.64.0.1", // RFC 6598 CGNAT
    "100.127.255.254", // RFC 6598 CGNAT upper bound
    "::ffff:100.64.0.1", // IPv4-mapped IPv6 — CGNAT
    "0.0.0.0", // RFC 1122 "This network"
    "0.255.255.255", // RFC 1122 upper bound
    "198.18.0.1", // RFC 2544 benchmark testing
    "198.19.255.254", // RFC 2544 upper bound
    "::ffff:0.0.0.0", // IPv4-mapped IPv6 — "This network"
    "::ffff:198.18.0.1", // IPv4-mapped IPv6 — benchmark
  ])("detects private IP: %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "203.0.113.1",
    "2607:f8b0:4004:800::200e",
    "2607:f8b0:4004:0800:0000:0000:0000:200e", // fully-expanded IPv6 (no ::)
    "::ffff:8.8.8.8", // IPv4-mapped IPv6 — public
  ])("allows public IP: %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  it("returns false for invalid IP", () => {
    expect(isPrivateIp("not-an-ip")).toBe(false);
  });
});

// ── validateEndpointUrl ─────────────────────────────────────────

function mockPublicDns(): void {
  mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
}

function mockPrivateDns(ip: string): void {
  mockLookup.mockResolvedValue([{ address: ip, family: 4 }]);
}

function mockDnsFailure(): void {
  mockLookup.mockRejectedValue(new Error("Name or service not known"));
}

describe("validateEndpointUrl", () => {
  // ── Scheme checks ───────────────────────────────────────────

  it("allows https", async () => {
    mockPublicDns();
    const result = await validateEndpointUrl("https://api.nvidia.com/v1");
    expect(result.url).toBe("https://api.nvidia.com/v1");
    expect(result.pinnedUrl).toBe("https://93.184.216.34/v1");
  });

  it("allows http", async () => {
    mockPublicDns();
    const result = await validateEndpointUrl("http://api.nvidia.com/v1");
    expect(result.url).toBe("http://api.nvidia.com/v1");
    expect(result.pinnedUrl).toBe("http://93.184.216.34/v1");
  });

  it("rejects file:// scheme", async () => {
    await expect(validateEndpointUrl("file:///etc/passwd")).rejects.toThrow(
      /Unsupported URL scheme/,
    );
  });

  it("rejects ftp:// scheme", async () => {
    await expect(validateEndpointUrl("ftp://evil.com/data")).rejects.toThrow(
      /Unsupported URL scheme/,
    );
  });

  it("rejects gopher:// scheme", async () => {
    await expect(validateEndpointUrl("gopher://evil.com/")).rejects.toThrow(
      /Unsupported URL scheme/,
    );
  });

  it("rejects empty scheme", async () => {
    await expect(validateEndpointUrl("://no-scheme.com")).rejects.toThrow(/No hostname/);
  });

  // ── Hostname checks ─────────────────────────────────────────

  it("rejects URL with no hostname", async () => {
    await expect(validateEndpointUrl("http://")).rejects.toThrow(/No hostname/);
  });

  it("rejects empty URL", async () => {
    await expect(validateEndpointUrl("")).rejects.toThrow(/No hostname/);
  });

  it("rejects javascript: with no hostname", async () => {
    await expect(validateEndpointUrl("javascript:alert(1)")).rejects.toThrow(
      /Unsupported URL scheme/,
    );
  });

  // ── Private IP checks (via DNS resolution) ──────────────────

  it("rejects private 10.x network", async () => {
    mockPrivateDns("10.0.0.1");
    await expect(validateEndpointUrl("https://attacker.com/ssrf")).rejects.toThrow(
      /private\/internal address/,
    );
  });

  it("rejects localhost", async () => {
    mockPrivateDns("127.0.0.1");
    await expect(validateEndpointUrl("https://attacker.com/ssrf")).rejects.toThrow(
      /private\/internal address/,
    );
  });

  it("rejects cloud metadata endpoint (169.254.169.254)", async () => {
    mockPrivateDns("169.254.169.254");
    await expect(validateEndpointUrl("https://attacker.com/metadata")).rejects.toThrow(
      /private\/internal address/,
    );
  });

  // ── DNS resolution failure ──────────────────────────────────

  it("rejects unresolvable hostname", async () => {
    mockDnsFailure();
    await expect(validateEndpointUrl("https://nonexistent.invalid/v1")).rejects.toThrow(
      /Cannot resolve hostname/,
    );
  });

  // ── Valid public endpoints ──────────────────────────────────

  it("allows NVIDIA API endpoint", async () => {
    mockPublicDns();
    const url = "https://integrate.api.nvidia.com/v1";
    const result = await validateEndpointUrl(url);
    expect(result.url).toBe(url);
    expect(result.pinnedUrl).toBe("https://93.184.216.34/v1");
  });

  it("allows URL with port", async () => {
    mockPublicDns();
    const url = "https://api.example.com:8443/v1";
    const result = await validateEndpointUrl(url);
    expect(result.url).toBe(url);
    expect(result.pinnedUrl).toBe("https://93.184.216.34:8443/v1");
  });

  it("preserves URL path", async () => {
    mockPublicDns();
    const url = "https://api.example.com/v1/chat/completions";
    const result = await validateEndpointUrl(url);
    expect(result.url).toBe(url);
    expect(result.pinnedUrl).toBe("https://93.184.216.34/v1/chat/completions");
  });
});

// ── Edge-case coverage ────────────────────────────────────────────

describe("isPrivateIp – CIDR boundary precision", () => {
  it.each([
    ["172.15.255.255", false], // just below 172.16.0.0/12
    ["172.16.0.0", true], // first address in 172.16.0.0/12
    ["172.31.255.255", true], // last address in 172.16.0.0/12
    ["172.32.0.0", false], // just above 172.16.0.0/12
    ["169.253.255.255", false], // just below 169.254.0.0/16
    ["169.254.0.0", true], // first address in 169.254.0.0/16
    ["169.255.0.0", false], // just above 169.254.0.0/16
    ["10.0.0.0", true], // first address in 10.0.0.0/8
    ["11.0.0.0", false], // just above 10.0.0.0/8
    ["126.255.255.255", false], // just below 127.0.0.0/8
    ["128.0.0.0", false], // just above 127.0.0.0/8
    ["192.167.255.255", false], // just below 192.168.0.0/16
    ["192.169.0.0", false], // just above 192.168.0.0/16
  ])("boundary %s → private=%s", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

describe("isPrivateIp – IPv6 edge cases", () => {
  it.each([
    // link-local, multicast, and unspecified are treated as private/internal for SSRF protection
    ["fe80::1", true],
    ["ff02::1", true],
    // zero address
    ["::0", true],
    // fc00::/7 (RFC 4193 Unique Local Addresses) boundaries
    ["fbff::1", false], // just below fc00::/7
    ["fc00::1", true], // first usable in fc00::/7 ULA range
    ["fcff::1", true], // within fc00::/7 ULA range
    ["fd00::0", true], // first address in fd00::/8 (within fc00::/7)
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], // last address in fc00::/7 ULA range
    ["fe00::1", false], // just above fc00::/7 (link-local starts at fe80::)
  ])("IPv6 %s → private=%s", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });

  it.each([
    "::ffff:169.254.169.254", // cloud metadata via IPv4-mapped IPv6
    "::ffff:10.255.255.255", // 10/8 upper bound via IPv4-mapped
    "::ffff:172.31.0.1", // 172.16/12 via IPv4-mapped
  ])("detects IPv4-mapped private address: %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each([
    "::ffff:8.8.4.4",
    "::ffff:172.32.0.1", // just outside 172.16/12
    "::ffff:11.0.0.1", // just outside 10/8
  ])("allows IPv4-mapped public address: %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });
});

describe("validateEndpointUrl – DNS rebinding", () => {
  it("rejects when ANY resolved address is private (mixed A records)", async () => {
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(validateEndpointUrl("https://rebind.attacker.com/api")).rejects.toThrow(
      /private\/internal address/,
    );
  });

  it("rejects when DNS returns private IPv6 among public IPv4", async () => {
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 },
    ]);
    await expect(validateEndpointUrl("https://rebind.attacker.com/api")).rejects.toThrow(
      /private\/internal address/,
    );
  });

  it("allows when all resolved addresses are public", async () => {
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2607:f8b0:4004:800::200e", family: 6 },
    ]);
    const result = await validateEndpointUrl("https://cdn.example.com/v1");
    expect(result.url).toBe("https://cdn.example.com/v1");
    expect(result.pinnedUrl).toBe("https://93.184.216.34/v1");
  });
});

describe("validateEndpointUrl – DNS pinning", () => {
  it("pins HTTP URL to resolved IP (prevents rebinding)", async () => {
    mockPublicDns();
    const result = await validateEndpointUrl("http://attacker.com:8080/v1");
    // pinnedUrl has IP instead of hostname — downstream connects to validated IP
    expect(result.pinnedUrl).toBe("http://93.184.216.34:8080/v1");
    // original URL preserved for reference
    expect(result.url).toBe("http://attacker.com:8080/v1");
  });

  it("pins HTTPS URL to resolved IP", async () => {
    mockPublicDns();
    const result = await validateEndpointUrl("https://api.example.com/v1");
    expect(result.pinnedUrl).toBe("https://93.184.216.34/v1");
  });

  it("pins IPv6 address with brackets", async () => {
    mockLookup.mockResolvedValue([{ address: "2607:f8b0:4004:800::200e", family: 6 }]);
    const result = await validateEndpointUrl("https://ipv6host.example.com/v1");
    expect(result.pinnedUrl).toBe("https://[2607:f8b0:4004:800::200e]/v1");
  });

  it("uses first resolved address for pinning", async () => {
    mockLookup.mockResolvedValue([
      { address: "1.2.3.4", family: 4 },
      { address: "5.6.7.8", family: 4 },
    ]);
    const result = await validateEndpointUrl("http://multi.example.com/v1");
    expect(result.pinnedUrl).toBe("http://1.2.3.4/v1");
  });
});

describe("validateEndpointUrl – URL parsing edge cases", () => {
  it("rejects data: URI", async () => {
    await expect(validateEndpointUrl("data:text/html,<h1>hi</h1>")).rejects.toThrow(
      /Unsupported URL scheme/,
    );
  });

  it("allows URL with query parameters", async () => {
    mockPublicDns();
    const url = "https://api.example.com/v1?key=abc&model=gpt";
    const result = await validateEndpointUrl(url);
    expect(result.url).toBe(url);
  });

  it("allows URL with fragment", async () => {
    mockPublicDns();
    const url = "https://api.example.com/v1#section";
    const result = await validateEndpointUrl(url);
    expect(result.url).toBe(url);
  });

  it("allows URL with userinfo/basic auth", async () => {
    mockPublicDns();
    // URL parser extracts hostname correctly even with userinfo
    const url = "https://user:pass@api.example.com/v1";
    const result = await validateEndpointUrl(url);
    expect(result.url).toBe(url);
  });
});
