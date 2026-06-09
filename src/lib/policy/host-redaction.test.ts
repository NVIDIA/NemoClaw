// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  canonicaliseHost,
  hostStemsFromEndpoints,
  isInternalHost,
} from "./host-redaction";

describe("canonicaliseHost", () => {
  it("returns null for empty / undefined / whitespace input", () => {
    expect(canonicaliseHost("")).toBeNull();
    expect(canonicaliseHost("   ")).toBeNull();
    expect(canonicaliseHost(undefined as unknown as string)).toBeNull();
  });

  it("trims, lowercases, and drops a trailing dot", () => {
    expect(canonicaliseHost(" API.SLACK.COM. ")).toBe("api.slack.com");
  });

  it("strips a URL scheme and userinfo", () => {
    expect(canonicaliseHost("https://example.com/path")).toBe("example.com");
    expect(canonicaliseHost("https://user:pass@example.com/path")).toBe("example.com");
    expect(canonicaliseHost("wss://token@api.slack.com")).toBe("api.slack.com");
  });

  it("strips a port from an IPv4 or hostname", () => {
    expect(canonicaliseHost("127.0.0.1:8080")).toBe("127.0.0.1");
    expect(canonicaliseHost("example.com:443")).toBe("example.com");
  });

  it("unwraps bracketed IPv6 and strips the port", () => {
    expect(canonicaliseHost("[::1]")).toBe("::1");
    expect(canonicaliseHost("[fe80::1]:443")).toBe("fe80::1");
    expect(canonicaliseHost("https://[::1]:8080/admin")).toBe("::1");
  });

  it("re-canonicalises IPv4-mapped IPv6 to the plain IPv4 stem", () => {
    expect(canonicaliseHost("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(canonicaliseHost("::ffff:192.168.1.10")).toBe("192.168.1.10");
  });

  it("returns null for malformed values that cannot be reduced to a bare stem", () => {
    expect(canonicaliseHost("ht!tp://broken host")).toBeNull();
    expect(canonicaliseHost("http://host with spaces")).toBeNull();
  });
});

describe("isInternalHost", () => {
  const internal = [
    "10.0.0.1",
    "10.255.255.255",
    "127.0.0.1",
    "127.42.42.42",
    "172.16.0.1",
    "172.20.0.5",
    "172.31.255.255",
    "192.168.1.10",
    "192.168.255.255",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.0.1",
    "198.18.0.1",
    "198.19.255.255",
    "0.0.0.0",
    "224.0.0.1",
    "::",
    "::1",
    "fe80::1",
    "fe80:1234::5678",
    "fe90::1",
    "fea0::1",
    "feb0::cafe",
    "febf::1",
    "fc00::1",
    "fd00::abcd",
    "ff02::1",
    "localhost",
    "ip6-localhost",
    "ip6-loopback",
    "broadcasthost",
    "host.local",
    "service.internal",
    "host.lan",
    "router.home",
    "thing.home.arpa",
    "x.corp",
    "y.intra",
    "z.intranet",
    "w.localdomain",
  ];

  for (const host of internal) {
    it(`treats ${host} as internal`, () => {
      expect(isInternalHost(host)).toBe(true);
    });
  }

  const external = [
    "api.slack.com",
    "example.com",
    "8.8.8.8",
    "1.1.1.1",
    "github.com",
    "registry.npmjs.org",
    // fec0::/10 is the deprecated site-local block. It sits immediately
    // above the fe80::/10 link-local range and must not be matched by the
    // link-local detector.
    "fec0::1",
    "2001:db8::1",
  ];
  for (const host of external) {
    it(`treats ${host} as external`, () => {
      expect(isInternalHost(host)).toBe(false);
    });
  }
});

describe("hostStemsFromEndpoints", () => {
  it("redacts every internal form regardless of bracket/port/URL syntax and counts the drop", () => {
    const result = hostStemsFromEndpoints([
      "127.0.0.1:8080",
      "[::1]",
      "[fe80::1]:443",
      "::ffff:127.0.0.1",
      "https://admin:tok@10.0.0.1/path",
      "https://192.168.1.10:8443/",
      "service.internal:5000",
      "broadcasthost",
      "registry.npmjs.org",
      "https://user:t@api.example.com:443/foo?bar",
    ]);

    expect(result.public).toEqual(["api.example.com", "registry.npmjs.org"]);
    expect(result.redactedCount).toBe(8);
  });

  it("drops malformed endpoints rather than passing them through unredacted", () => {
    const result = hostStemsFromEndpoints([
      "https://has spaces.example.com",
      "javascript:alert(1)",
      "valid.example.com",
    ]);
    expect(result.public).toEqual(["valid.example.com"]);
    expect(result.redactedCount).toBe(2);
  });
});
