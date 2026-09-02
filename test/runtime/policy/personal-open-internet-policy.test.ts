// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { BlockList, isIP } from "node:net";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import * as policies from "../../../src/lib/policy";
import { ROOT } from "../../../src/lib/runner";
import * as registry from "../../../src/lib/state/registry";

type Endpoint = {
  allowed_ips?: string[];
  host?: string;
  port?: number;
  ports?: number[];
  protocol?: string;
  rules?: unknown[];
};

type NetworkPolicy = {
  binaries?: Array<{ path?: string }>;
  endpoints?: Endpoint[];
  name?: string;
};

type PolicyDocument = {
  filesystem_policy?: unknown;
  network_policies?: Record<string, NetworkPolicy>;
  process?: unknown;
};

const AGENT_POLICY_BASELINES = [
  [
    "openclaw",
    "OpenClaw",
    path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
  ],
  ["hermes", "Hermes", path.join(ROOT, "agents", "hermes", "policy-additions.yaml")],
  [
    "langchain-deepagents-code",
    "Deep Agents Code",
    path.join(ROOT, "agents", "langchain-deepagents-code", "policy-additions.yaml"),
  ],
  ["pi", "Pi", path.join(ROOT, "agents", "pi", "policy-additions.yaml")],
] as const;

const PERSONAL_COMPOSITION_CASES = AGENT_POLICY_BASELINES.flatMap(
  ([agent, displayName, baselinePath]) => [
    [
      displayName,
      "Personal first",
      agent,
      baselinePath,
      ["personal-open-internet", "weather"],
    ] as const,
    [
      displayName,
      "Personal last",
      agent,
      baselinePath,
      ["weather", "personal-open-internet"],
    ] as const,
  ],
);

function parsePolicy(content: string): PolicyDocument {
  return YAML.parse(content) as PolicyDocument;
}

function loadPersonalInternetPolicy(): NetworkPolicy {
  const content = policies.loadPreset("personal-open-internet");
  expect(content).not.toBeNull();
  return parsePolicy(content ?? "").network_policies?.personal_open_internet ?? {};
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

function expectNoWebEndpoints(policies: Record<string, NetworkPolicy>): void {
  for (const [policyName, policy] of Object.entries(policies)) {
    for (const endpoint of policy.endpoints ?? []) {
      const ports = [endpoint.port, ...(endpoint.ports ?? [])];
      expect(ports, policyName).not.toContain(80);
      expect(ports, policyName).not.toContain(443);
    }
  }
}

describe("Personal open internet policy preset", () => {
  it("uses OpenShell hostless L4 matching on ports 80 and 443 from every binary", () => {
    const policy = loadPersonalInternetPolicy();

    expect(policy.binaries).toEqual([{ path: "/**" }]);
    expect(policy.endpoints).toHaveLength(1);
    expect(policy.endpoints?.[0]).toMatchObject({ ports: [80, 443] });
    (policy.endpoints ?? []).forEach((endpoint) => {
      expect(endpoint.port).toBeUndefined();
      expect(endpoint.host).toBeUndefined();
      expect(endpoint.protocol).toBeUndefined();
      expect(endpoint.rules).toBeUndefined();
      expect(endpoint.allowed_ips?.length).toBeGreaterThan(0);
    });
  });

  it("covers public and private networks without forbidden catch-all CIDRs", () => {
    const endpoint = loadPersonalInternetPolicy().endpoints?.[0];
    const allowedIps = new Set(endpoint?.allowed_ips ?? []);
    const isAllowed = allowedAddressMatcher([...allowedIps]);

    expect(allowedIps.size).toBe(29);
    expect(allowedIps).not.toContain("0.0.0.0/0");
    expect(allowedIps).not.toContain("127.0.0.0/8");
    expect(allowedIps).not.toContain("169.254.0.0/16");
    expect(allowedIps).not.toContain("::/0");
    expect(
      ["8.8.8.8", "10.0.0.1", "2001:4860:4860::8888", "fc00::1"].every((address) =>
        Object.is(isAllowed(address), true),
      ),
    ).toBe(true);
  });

  it.each(PERSONAL_COMPOSITION_CASES)(
    "makes Personal the sole web authority for %s regardless of order: %s",
    (_displayName, _order, agent, baselinePath, names) => {
      expect(fs.existsSync(baselinePath), baselinePath).toBe(true);
      const baseline = fs.readFileSync(baselinePath, "utf8");
      expect(baseline.trim(), baselinePath).not.toBe("");
      const original = parsePolicy(baseline);
      const result = policies.mergePresetNamesIntoPolicy(baseline, [...names], { agent });
      const effective = parsePolicy(result.policy);
      const { network_policies: _originalNetworkPolicies, ...originalNonNetwork } = original;
      const { network_policies: effectiveNetworkPolicies, ...effectiveNonNetwork } = effective;
      const { personal_open_internet: personalPolicy, ...otherPolicies } =
        effectiveNetworkPolicies ?? {};

      expect(result.appliedPresets).toEqual(names);
      expect(result.missingPresets).toEqual([]);
      expect(effectiveNonNetwork).toEqual(originalNonNetwork);
      expect(personalPolicy).toEqual(loadPersonalInternetPolicy());
      expect(effectiveNetworkPolicies?.weather).toBeUndefined();

      expectNoWebEndpoints(otherPolicies);
    },
  );

  it("preserves non-web and mixed-port endpoint authority", () => {
    const current = YAML.stringify({
      version: 1,
      network_policies: {
        mixed: {
          name: "mixed",
          endpoints: [
            { host: "mixed.example", ports: [80, 443, 8443] },
            { host: "mail.example", port: 993 },
          ],
          binaries: [{ path: "/usr/bin/curl" }],
        },
      },
    });
    const result = policies.mergePresetNamesIntoPolicy(current, ["personal-open-internet"]);
    expect(parsePolicy(result.policy).network_policies?.mixed?.endpoints).toEqual([
      { host: "mixed.example", ports: [8443] },
      { host: "mail.example", port: 993 },
    ]);
  });

  it("fails closed when the reserved live Personal entry drifts", () => {
    const drifted = YAML.stringify({
      version: 1,
      network_policies: {
        personal_open_internet: {
          name: "personal_open_internet",
          endpoints: [{ ports: [80, 443], allowed_ips: ["8.8.8.8"] }],
          binaries: [{ path: "/**" }],
        },
      },
    });
    expect(() => policies.mergePresetNamesIntoPolicy(drifted, ["weather"])).toThrow(
      /does not match the reviewed built-in preset/,
    );
    expect(() =>
      policies.mergePresetNamesIntoPolicy(
        YAML.stringify({
          version: 1,
          network_policies: { personal_open_internet: "unreviewed" },
        }),
        ["weather"],
      ),
    ).toThrow(/does not match the reviewed built-in preset/);
  });

  it("rejects direct custom Personal key ownership before reading live state", () => {
    const registryLookup = vi.spyOn(registry, "getSandbox").mockImplementation(() => {
      throw new Error("registry must not be read");
    });
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    try {
      expect(
        policies.applyPresetContent(
          "personal-key-guard",
          "spoofed-personal",
          YAML.stringify({
            preset: { name: "spoofed-personal" },
            network_policies: {
              personal_open_internet: {
                name: "spoofed-personal",
                endpoints: [{ host: "attacker.example", port: 443 }],
                binaries: [{ path: "/usr/bin/curl" }],
              },
            },
          }),
          { custom: { sourcePath: "/tmp/spoofed-personal.yaml" } },
        ),
      ).toBe(false);
      expect(registryLookup).not.toHaveBeenCalled();
      expect(errors.join("\n")).toContain("reserved network policy key 'personal_open_internet'");
    } finally {
      errorSpy.mockRestore();
      registryLookup.mockRestore();
    }
  });

  it.each([80, 443])(
    "excludes normalized hard-blocked address classes at the connection boundary on port %i",
    (port) => {
      const endpoint = loadPersonalInternetPolicy().endpoints?.[0];
      expect(endpoint).toBeDefined();
      expect(endpoint!.ports).toContain(port);
      const isAllowed = allowedAddressMatcher(endpoint!.allowed_ips ?? []);

      expect(
        [
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
        ].every((address) => Object.is(isAllowed(address), false)),
      ).toBe(true);

      expect(
        ["8.8.8.8", "10.0.0.1", "2001:4860:4860::8888", "fc00::1"].every((address) =>
          Object.is(isAllowed(address), true),
        ),
      ).toBe(true);
    },
  );

  it("refuses direct Personal removal before reading registry or gateway state", () => {
    const registryLookup = vi.spyOn(registry, "getSandbox").mockImplementation(() => {
      throw new Error("registry must not be read");
    });
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    expect(policies.removePreset("personal-guard", "personal-open-internet")).toBe(false);
    expect(registryLookup).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("cannot be removed in place");

    errorSpy.mockRestore();
    registryLookup.mockRestore();
  });
});
