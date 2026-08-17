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

type NetworkPolicyEntry = {
  name?: string;
  binaries?: Array<{ path?: string }>;
  endpoints?: Endpoint[];
};

type PolicyDocument = {
  version?: number;
  network_policies: Record<string, NetworkPolicyEntry>;
};

const BASELINE_KEYS = [
  "nvidia",
  "managed_inference",
  "openclaw_gateway_dialback",
  "clawhub",
  "openclaw_api",
  "openclaw_docs",
  "npm_registry",
] as const;

function loadBaselineDocument(): PolicyDocument {
  const baseline = policies.resolveAgentBaselinePolicy("openclaw");
  expect(baseline).not.toBeNull();
  return YAML.parse(baseline?.content ?? "") as PolicyDocument;
}

function composeDefaultPolicy(): PolicyDocument {
  const baseline = policies.resolveAgentBaselinePolicy("openclaw");
  expect(baseline).not.toBeNull();
  const merged = policies.mergePresetNamesIntoPolicy(baseline?.content ?? "", [
    "personal-open-internet",
  ]);
  expect(merged.appliedPresets).toEqual(["personal-open-internet"]);
  expect(merged.missingPresets).toEqual([]);
  return YAML.parse(merged.policy) as PolicyDocument;
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

describe("Portable default policy finality", () => {
  it("composing the default open-internet preset preserves every mandatory baseline policy entry (#9206)", () => {
    const baseline = loadBaselineDocument();
    const composed = composeDefaultPolicy();

    expect(Object.keys(baseline.network_policies).sort()).toEqual([...BASELINE_KEYS].sort());
    expect(Object.keys(composed.network_policies)).toEqual(
      expect.arrayContaining([...BASELINE_KEYS]),
    );
    expect(composed.network_policies.managed_inference).toEqual(
      baseline.network_policies.managed_inference,
    );
  });

  it("composing the default open-internet preset adds a new policy key without substituting a baseline key (#9206)", () => {
    const baselineKeys = Object.keys(loadBaselineDocument().network_policies);
    const composedKeys = Object.keys(composeDefaultPolicy().network_policies);

    expect(composedKeys).toHaveLength(baselineKeys.length + 1);
    expect(composedKeys.filter((key) => !baselineKeys.includes(key))).toEqual([
      "personal_open_internet",
    ]);
  });

  it("does not use unrestricted IP address ranges in the composed default policy (#9206)", () => {
    const entry = composeDefaultPolicy().network_policies.personal_open_internet;
    expect(entry?.endpoints).toHaveLength(1);
    const endpoint = entry?.endpoints?.[0] as Endpoint;

    expect(endpoint.host).toBeUndefined();
    expect(endpoint.protocol).toBeUndefined();
    const allowedIps = endpoint.allowed_ips ?? [];
    expect(allowedIps).not.toContain("0.0.0.0/0");
    expect(allowedIps).not.toContain("::/0");
  });

  it.each([
    "0.0.0.0",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254",
    "::",
    "::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
  ])("denies the non-public address %s in the composed default policy (#9206)", (address) => {
    const endpoint = composeDefaultPolicy().network_policies.personal_open_internet
      ?.endpoints?.[0] as Endpoint;
    const isAllowed = allowedAddressMatcher(endpoint.allowed_ips ?? []);

    expect(isAllowed(address), address).toBe(false);
  });

  it.each(["8.8.8.8", "2001:4860:4860::8888"])(
    "allows the public address %s in the composed default policy (#9206)",
    (address) => {
      const endpoint = composeDefaultPolicy().network_policies.personal_open_internet
        ?.endpoints?.[0] as Endpoint;
      const isAllowed = allowedAddressMatcher(endpoint.allowed_ips ?? []);

      expect(isAllowed(address), address).toBe(true);
    },
  );
});
