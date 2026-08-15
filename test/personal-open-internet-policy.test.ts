// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { BlockList, isIP } from "node:net";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import * as policies from "../src/lib/policy";

type Endpoint = {
  host?: string;
  port?: number;
  ports?: number[];
  protocol?: string;
  access?: string;
  rules?: unknown[];
  allowed_ips?: string[];
};

function loadPersonalInternetPolicy(): {
  endpoints: Endpoint[];
  binaries: Array<{ path?: string }>;
} {
  const content = policies.loadPreset("personal-open-internet");
  expect(content).not.toBeNull();
  const document = YAML.parse(content ?? "");
  return document.network_policies.personal_open_internet;
}

function allowedAddressMatcher(cidrs: readonly string[]): (address: string) => boolean {
  const allowed = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefixText] = cidr.split("/");
    const family = isIP(address ?? "");
    const prefix = Number(prefixText);
    expect(family, cidr).not.toBe(0);
    expect(Number.isInteger(prefix), cidr).toBe(true);
    allowed.addSubnet(address!, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return (address: string): boolean => {
    const family = isIP(address);
    return family !== 0 && allowed.check(address, family === 4 ? "ipv4" : "ipv6");
  };
}

describe("Personal open internet policy preset", () => {
  it("uses OpenShell hostless L4 matching on TCP ports 80 and 443 from every binary", () => {
    const policy = loadPersonalInternetPolicy();

    expect(policy.binaries).toEqual([{ path: "/**" }]);
    expect(policy.endpoints).toHaveLength(1);
    expect(policy.endpoints[0]?.ports).toEqual([80, 443]);
    for (const endpoint of policy.endpoints) {
      expect(endpoint.port).toBeUndefined();
      expect(endpoint.host).toBeUndefined();
      expect(endpoint.protocol).toBeUndefined();
      expect(endpoint.access).toBeUndefined();
      expect(endpoint.rules).toBeUndefined();
      expect(endpoint.allowed_ips?.length).toBeGreaterThan(0);
    }
  });

  it("covers public and private networks without forbidden catch-all CIDRs", () => {
    const policy = loadPersonalInternetPolicy();
    const allowedIps = new Set(policy.endpoints[0]?.allowed_ips ?? []);

    expect(allowedIps.size).toBe(29);
    expect(allowedIps).toContain("1.0.0.0/8");
    expect(allowedIps).toContain("172.0.0.0/6");
    expect(allowedIps).toContain("192.0.0.0/2");
    expect(allowedIps).toContain("2000::/3");
    expect(allowedIps).toContain("fc00::/7");
    expect(allowedIps).not.toContain("0.0.0.0/0");
    expect(allowedIps).not.toContain("127.0.0.0/8");
    expect(allowedIps).not.toContain("169.254.0.0/16");
    expect(allowedIps).not.toContain("::/0");
  });

  it.each([
    80, 443,
  ])("excludes normalized hard-blocked address classes at the connection boundary on port %i", (port) => {
    const endpoint = loadPersonalInternetPolicy().endpoints[0]!;
    expect(endpoint.ports).toContain(port);
    const isAllowed = allowedAddressMatcher(endpoint.allowed_ips ?? []);

    for (const address of [
      "0.0.0.0",
      "127.0.0.1",
      "127.1.2.3",
      "169.254.169.254",
      "::",
      "::1",
      "0:0:0:0:0:0:0:1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "0:0:0:0:0:ffff:7f00:1",
      "::ffff:169.254.169.254",
    ]) {
      expect(isAllowed(address), address).toBe(false);
    }

    for (const address of ["8.8.8.8", "10.0.0.1", "2001:4860:4860::8888", "fc00::1"]) {
      expect(isAllowed(address), address).toBe(true);
    }
  });

  it("composes unchanged into the create-time sandbox policy", () => {
    const merged = policies.mergePresetNamesIntoPolicy("version: 1\nnetwork_policies: {}\n", [
      "personal-open-internet",
    ]);
    const endpoint = YAML.parse(merged.policy).network_policies.personal_open_internet
      .endpoints[0] as Endpoint;

    expect(merged.appliedPresets).toEqual(["personal-open-internet"]);
    expect(endpoint).toMatchObject({ ports: [80, 443] });
    expect(endpoint.host).toBeUndefined();
    expect(endpoint.protocol).toBeUndefined();
    expect(endpoint.allowed_ips).toContain("192.0.0.0/2");
  });
});
