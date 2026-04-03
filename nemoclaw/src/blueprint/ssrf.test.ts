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
    await expect(validateEndpointUrl("https://api.nvidia.com/v1")).resolves.toBe(
      "https://api.nvidia.com/v1",
    );
  });

  it("allows http", async () => {
    mockPublicDns();
    await expect(validateEndpointUrl("http://api.nvidia.com/v1")).resolves.toBe(
      "http://api.nvidia.com/v1",
    );
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
    await expect(validateEndpointUrl(url)).resolves.toBe(url);
  });

  it("allows URL with port", async () => {
    mockPublicDns();
    const url = "https://api.example.com:8443/v1";
    await expect(validateEndpointUrl(url)).resolves.toBe(url);
  });

  it("preserves URL path", async () => {
    mockPublicDns();
    const url = "https://api.example.com/v1/chat/completions";
    await expect(validateEndpointUrl(url)).resolves.toBe(url);
  });
});
