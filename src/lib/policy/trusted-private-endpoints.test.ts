// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import type { EndpointDnsLookupFn } from "../security/trusted-private-endpoint";
import {
  isTrustedPrivatePolicyPinCapability,
  prepareTrustedPrivatePolicyPresets,
} from "./trusted-private-endpoints";

function preset(content: string) {
  return { filePath: "/tmp/private.yaml", presetName: "private", content };
}

function lookup(records: Record<string, string[]>): EndpointDnsLookupFn {
  return async (hostname) => (records[hostname] ?? []).map((address) => ({ address }));
}

describe("trusted private custom policy preparation", () => {
  it.each([
    "10.20.30.40",
    "127.0.0.1",
    "169.254.169.254",
    "fe80::1",
    "metadata.google.internal",
  ])("rejects an untrusted private or special-use endpoint host %s", async (host) => {
    const input = preset(`preset:
  name: private
network_policies:
  service:
    endpoints:
      - host: "${host}"
        port: 80
        protocol: rest
`);

    await expect(prepareTrustedPrivatePolicyPresets([input], [])).rejects.toThrow(
      /endpoint host.*is rejected.*explicit trust only for RFC1918, CGNAT, or IPv6 unique local/i,
    );
  });

  it("preserves public and OpenShell bridge endpoints without private trust", async () => {
    const input = preset(`preset:
  name: private
network_policies:
  service:
    endpoints:
      - { host: api.example.com, port: 443, protocol: rest }
      - { host: host.openshell.internal, port: 8080, protocol: rest }
`);

    await expect(prepareTrustedPrivatePolicyPresets([input], [])).resolves.toEqual([{ ...input }]);
  });

  it("pins an explicitly trusted private IP literal", async () => {
    const input = preset(`preset:
  name: private
network_policies:
  service:
    endpoints:
      - { host: 10.20.30.40, port: 443, protocol: rest }
`);

    const [prepared] = await prepareTrustedPrivatePolicyPresets([input], ["10.20.30.40"]);
    const document = YAML.parse(prepared.content) as {
      network_policies: { service: { endpoints: Array<{ allowed_ips?: string[] }> } };
    };

    expect(document.network_policies.service.endpoints[0]?.allowed_ips).toEqual(["10.20.30.40"]);
    expect(
      isTrustedPrivatePolicyPinCapability(prepared.content, prepared.trustedPrivatePinCapability),
    ).toBe(true);
  });

  it("rejects an explicitly declared link-local metadata IP", async () => {
    const input = preset(`preset:
  name: private
network_policies:
  service:
    endpoints:
      - { host: 169.254.169.254, port: 80, protocol: rest }
`);

    await expect(
      prepareTrustedPrivatePolicyPresets([input], ["169.254.169.254"]),
    ).rejects.toThrow(/failed destination preflight/i);
  });

  it("does not let one trusted endpoint authorize an untrusted special-use sibling", async () => {
    const input = preset(`preset:
  name: private
network_policies:
  service:
    endpoints:
      - { host: api.corp.example, port: 443, protocol: rest }
      - { host: 169.254.169.254, port: 80, protocol: rest }
`);

    await expect(
      prepareTrustedPrivatePolicyPresets([input], ["api.corp.example"], {
        lookup: lookup({ "api.corp.example": ["10.20.30.40"] }),
      }),
    ).rejects.toThrow(/169\.254\.169\.254.*is rejected/i);
  });

  it("pins trusted endpoints across every policy protocol (#8176)", async () => {
    const input = preset(`preset:
  name: private
network_policies:
  services:
    name: services
    endpoints:
      - { host: api.corp.example, port: 443, protocol: rest }
      - { host: api.corp.example, port: 443, protocol: websocket }
      - { host: api.corp.example, port: 443, protocol: jsonrpc }
      - { host: api.corp.example, port: 443, protocol: mcp }
    binaries:
      - { path: /usr/local/bin/node }
`);

    const [prepared] = await prepareTrustedPrivatePolicyPresets([input], ["API.CORP.EXAMPLE."], {
      lookup: lookup({ "api.corp.example": ["fd00::40", "10.20.30.40"] }),
    });
    const document = YAML.parse(prepared.content) as {
      network_policies: { services: { endpoints: Array<{ allowed_ips?: string[] }> } };
    };
    expect(document.network_policies.services.endpoints).toHaveLength(4);
    document.network_policies.services.endpoints.forEach((endpoint) => {
      expect(endpoint.allowed_ips).toEqual(["10.20.30.40", "fd00::40"]);
    });
    expect(
      isTrustedPrivatePolicyPinCapability(prepared.content, prepared.trustedPrivatePinCapability),
    ).toBe(true);
    expect(
      isTrustedPrivatePolicyPinCapability(
        `${prepared.content}\n# changed`,
        prepared.trustedPrivatePinCapability,
      ),
    ).toBe(false);
    expect(input.content).not.toContain("allowed_ips");
  });

  it.each(["rest", "websocket", "jsonrpc", "mcp"])(
    "pins mixed public and trusted-private DNS answers for %s endpoints (#8176)",
    async (protocol) => {
      const input = preset(`preset:
  name: private
network_policies:
  services:
    endpoints:
      - { host: api.corp.example, port: 443, protocol: ${protocol} }
`);

      const [prepared] = await prepareTrustedPrivatePolicyPresets([input], ["api.corp.example"], {
        lookup: lookup({ "api.corp.example": ["10.20.30.40", "8.8.8.8"] }),
      });
      const document = YAML.parse(prepared.content) as {
        network_policies: { services: { endpoints: Array<{ allowed_ips?: string[] }> } };
      };

      expect(document.network_policies.services.endpoints[0]?.allowed_ips).toEqual([
        "10.20.30.40",
        "8.8.8.8",
      ]);
      expect(
        isTrustedPrivatePolicyPinCapability(prepared.content, prepared.trustedPrivatePinCapability),
      ).toBe(true);
      expect(input.content).not.toContain("allowed_ips");
    },
  );

  it("preserves the reviewed host-gateway exception beside generated private pins (#8176)", async () => {
    const input = preset(`preset:
  name: private
network_policies:
  services:
    endpoints:
      - host: host.openshell.internal
        allowed_ips: [10.0.0.0/8]
      - host: api.corp.example
        allowed_ips: []
`);
    // Source files may contain bridge pins, but not a placeholder on the
    // private endpoint. Remove it before preparation to model valid input.
    input.content = input.content.replace("        allowed_ips: []\n", "");

    const [prepared] = await prepareTrustedPrivatePolicyPresets([input], ["api.corp.example"], {
      lookup: lookup({ "api.corp.example": ["10.20.30.40"] }),
    });
    const document = YAML.parse(prepared.content) as {
      network_policies: { services: { endpoints: Array<{ allowed_ips?: string[] }> } };
    };
    expect(document.network_policies.services.endpoints[0]?.allowed_ips).toEqual(["10.0.0.0/8"]);
    expect(document.network_policies.services.endpoints[1]?.allowed_ips).toEqual(["10.20.30.40"]);
    expect(
      isTrustedPrivatePolicyPinCapability(prepared.content, prepared.trustedPrivatePinCapability),
    ).toBe(true);
  });

  it("requires every declaration to match an endpoint (#8176)", async () => {
    const input = preset(`preset:
  name: private
network_policies:
  service:
    endpoints:
      - { host: api.corp.example, port: 443, protocol: rest }
`);
    await expect(
      prepareTrustedPrivatePolicyPresets([input], ["api.corp.example", "unused.corp.example"], {
        lookup: lookup({ "api.corp.example": ["10.20.30.40"] }),
      }),
    ).rejects.toThrow(/unused\.corp\.example.*does not match/i);
  });

  it("treats an ambient declaration for a public endpoint as a no-op (#8176)", async () => {
    const input = preset(`preset:
  name: private
network_policies:
  service:
    endpoints:
      - { host: api.corp.example, port: 443, protocol: rest }
`);
    const [prepared] = await prepareTrustedPrivatePolicyPresets([input], ["api.corp.example"], {
      lookup: lookup({ "api.corp.example": ["93.184.216.34"] }),
      requiredDeclarations: [],
    });

    expect(prepared.content).not.toContain("allowed_ips");
    expect(prepared.trustedPrivatePinCapability).toBeUndefined();
  });

  it("rejects duplicate, public-only, and disallowed private declarations (#8176)", async () => {
    const input = preset(`preset:
  name: private
network_policies:
  service:
    endpoints:
      - { host: api.corp.example, port: 443, protocol: rest }
`);
    await expect(
      prepareTrustedPrivatePolicyPresets([input], ["api.corp.example", "API.CORP.EXAMPLE."]),
    ).rejects.toThrow(/declared more than once/i);
    await expect(
      prepareTrustedPrivatePolicyPresets([input], ["api.corp.example"], {
        lookup: lookup({ "api.corp.example": ["8.8.8.8"] }),
      }),
    ).rejects.toThrow(/did not resolve to an operator-trustable private address/i);
    await expect(
      prepareTrustedPrivatePolicyPresets([input], ["api.corp.example"], {
        lookup: lookup({ "api.corp.example": ["127.0.0.1"] }),
      }),
    ).rejects.toThrow(/failed destination preflight/i);
  });

  it("defensively rejects user-authored pins before generated injection (#8176)", async () => {
    const input = preset(`preset:
  name: private
network_policies:
  service:
    endpoints:
      - host: api.corp.example
        port: 443
        protocol: rest
        allowed_ips: [10.20.30.40]
`);
    await expect(prepareTrustedPrivatePolicyPresets([input], ["api.corp.example"])).rejects.toThrow(
      /user-authored allowed_ips/i,
    );
  });
});
