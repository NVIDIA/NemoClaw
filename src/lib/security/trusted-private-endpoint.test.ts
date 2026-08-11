// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  assertEndpointResolvesPublic,
  assertTrustedPrivateEndpointCapability,
  canonicalizeTrustedPrivateEndpointPins,
  type EndpointDnsLookupFn,
  isOperatorTrustablePrivateIp,
  isTrustedPrivateEndpointCapability,
  normalizeTrustedPrivateHost,
  parseTrustedPrivateHosts,
  replayTrustedPrivateEndpoint,
} from "./trusted-private-endpoint";

const resolverTo = (address: string): EndpointDnsLookupFn =>
  vi.fn(async () => [{ address, family: address.includes(":") ? 6 : 4 }]);

describe("trusted private endpoint hosts", () => {
  it.each([
    [" MCP.CORP.EXAMPLE. ", "mcp.corp.example"],
    ["10.20.30.40", "10.20.30.40"],
    ["[fd00::10]", "fd00::10"],
    ["FD00::10", "fd00::10"],
    ["fd00:0:0:0:0:0:0:10", "fd00::10"],
  ])("normalizes the exact host %s (#8176)", (raw, expected) => {
    expect(normalizeTrustedPrivateHost(raw)).toBe(expected);
  });

  it.each([
    "",
    "https://mcp.corp.example",
    "mcp.corp.example:443",
    "mcp.corp.example/path",
    "mcp.corp.example?query",
    "mcp.corp.example#fragment",
    "*.corp.example",
    ".corp.example",
    "10.0.0.0/8",
    "user@mcp.corp.example",
    "mcp..corp.example",
    "-mcp.corp.example",
    "mcp-.corp.example",
    "999.1.1.1",
    "[mcp.corp.example]",
  ])("rejects the non-exact host input %s (#8176)", (raw) => {
    expect(() => normalizeTrustedPrivateHost(raw)).toThrow(/trusted private host/);
  });

  it("parses and deduplicates exact hosts from the generic source (#8176)", () => {
    expect(parseTrustedPrivateHosts(" MCP.CORP.EXAMPLE.,10.0.0.8,mcp.corp.example ")).toEqual([
      "mcp.corp.example",
      "10.0.0.8",
    ]);
    expect(parseTrustedPrivateHosts(undefined)).toEqual([]);
  });

  it("rejects an empty entry in a configured host list (#8176)", () => {
    expect(() => parseTrustedPrivateHosts("mcp.corp.example,,10.0.0.8")).toThrow(
      /must not be empty/,
    );
  });
});

describe("trusted private endpoint preflight", () => {
  it.each([
    "10.0.0.1",
    "100.64.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "fd00::1",
  ])("classifies the operator-trustable address %s (#8176)", (address) => {
    expect(isOperatorTrustablePrivateIp(address)).toBe(true);
  });

  it.each([
    "127.0.0.1",
    "169.254.169.254",
    "198.18.0.1",
    "fe80::1",
    "ff00::1",
  ])("keeps the reserved address %s outside operator trust (#8176)", (address) => {
    expect(isOperatorTrustablePrivateIp(address)).toBe(false);
  });

  it("issues a provenance-checked capability for an exact trusted host (#8176)", async () => {
    const result = await assertEndpointResolvesPublic(
      "https://mcp.corp.example/mcp",
      resolverTo("10.0.0.8"),
      { trustedPrivateHosts: ["mcp.corp.example"] },
    );

    expect(result).toMatchObject({
      ok: true,
      addresses: ["10.0.0.8"],
      trustedPrivateEndpoint: true,
    });
    expect(result.trustedPrivateCapability?.host).toBe("mcp.corp.example");
    expect(result.trustedPrivateCapability?.addresses).toEqual(["10.0.0.8"]);
    expect(isTrustedPrivateEndpointCapability(result.trustedPrivateCapability)).toBe(true);
    expect(
      isTrustedPrivateEndpointCapability({ host: "mcp.corp.example", addresses: ["10.0.0.8"] }),
    ).toBe(false);
  });

  it("pins every accepted mixed public and trusted-private answer (#8176)", async () => {
    const result = await assertEndpointResolvesPublic(
      "https://mcp.corp.example/mcp",
      vi.fn(async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.8", family: 4 },
      ]),
      { trustedPrivateHosts: ["mcp.corp.example"] },
    );

    expect(result).toMatchObject({
      ok: true,
      addresses: ["10.0.0.8", "93.184.216.34"],
      trustedPrivateEndpoint: true,
    });
    expect(result.trustedPrivateCapability).toMatchObject({
      host: "mcp.corp.example",
      addresses: ["10.0.0.8", "93.184.216.34"],
    });
  });

  it.each([
    "http://127.0.0.1:8000/v1",
    "https://inference.local/v1",
    "http://host.openshell.internal:8000/v1",
  ])("rejects the generic local endpoint %s before resolution (#8176)", async (endpointUrl) => {
    const lookup = vi.fn<EndpointDnsLookupFn>();
    const result = await assertEndpointResolvesPublic(endpointUrl, lookup);

    expect(result).toMatchObject({ ok: false, reasonCode: "rejected" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects a private result for a different exact host (#8176)", async () => {
    const result = await assertEndpointResolvesPublic(
      "https://attacker.mcp.corp.example/mcp",
      resolverTo("10.0.0.8"),
      { trustedPrivateHosts: ["mcp.corp.example"] },
    );

    expect(result.ok).toBe(false);
    expect(result.trustedPrivateCapability).toBeUndefined();
  });

  it("rejects link-local metadata for an exact trusted host (#8176)", async () => {
    const result = await assertEndpointResolvesPublic(
      "https://mcp.corp.example/mcp",
      resolverTo("169.254.169.254"),
      { trustedPrivateHosts: ["mcp.corp.example"] },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("169.254.169.254");
  });

  it("preserves public endpoint preflight behavior (#8176)", async () => {
    const result = await assertEndpointResolvesPublic(
      "https://mcp.example/mcp",
      resolverTo("93.184.216.34"),
    );

    expect(result).toEqual({ ok: true, addresses: ["93.184.216.34"] });
  });
});

describe("trusted private endpoint replay", () => {
  it("uses one canonical pin contract for durable and capability authority (#8176)", async () => {
    const result = await assertEndpointResolvesPublic(
      "https://mcp.corp.example/mcp",
      async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.8", family: 4 },
      ],
      { trustedPrivateHosts: ["mcp.corp.example"] },
    );
    const canonical = canonicalizeTrustedPrivateEndpointPins("MCP.CORP.EXAMPLE.", [
      "93.184.216.34",
      "10.0.0.8",
    ]);

    expect(canonical).toEqual({
      host: "mcp.corp.example",
      addresses: ["10.0.0.8", "93.184.216.34"],
    });
    expect(
      assertTrustedPrivateEndpointCapability(
        canonical.host,
        canonical.addresses,
        result.trustedPrivateCapability,
      ).addresses,
    ).toEqual(canonical.addresses);
    expect(() =>
      assertTrustedPrivateEndpointCapability(
        canonical.host,
        ["10.0.0.8"],
        result.trustedPrivateCapability,
      ),
    ).toThrow(/exact pins/);
  });

  it("reissues capability authority from exact durable pins without DNS (#8267)", () => {
    const replay = replayTrustedPrivateEndpoint("MCP.CORP.EXAMPLE.", [
      "fd00:0:0:0:0:0:0:10",
      "10.0.0.8",
    ]);

    expect(replay.host).toBe("mcp.corp.example");
    expect(replay.addresses).toEqual(["10.0.0.8", "fd00::10"]);
    expect(replay.trustedPrivateCapability.host).toBe("mcp.corp.example");
    expect(replay.trustedPrivateCapability.addresses).toEqual(replay.addresses);
    expect(isTrustedPrivateEndpointCapability(replay.trustedPrivateCapability)).toBe(true);
  });

  it("replays complete mixed pins for consumers that allow them (#8176)", () => {
    const replay = replayTrustedPrivateEndpoint("mcp.corp.example", ["93.184.216.34", "10.0.0.8"]);

    expect(replay.trustedPrivateCapability).toMatchObject({
      host: "mcp.corp.example",
      addresses: ["10.0.0.8", "93.184.216.34"],
    });
  });

  it("rejects mixed durable pins for consumers that require routed-private pins (#8267)", () => {
    expect(() =>
      replayTrustedPrivateEndpoint("mcp.corp.example", ["10.0.0.8", "93.184.216.34"], {
        requireAllPrivate: true,
      }),
    ).toThrow(/outside the supported private ranges/);
  });

  it.each([
    ["no pins", []],
    ["public pin", ["93.184.216.34"]],
    ["loopback pin", ["127.0.0.1"]],
    ["link-local pin", ["169.254.169.254"]],
    ["duplicate pin", ["10.0.0.8", "10.0.0.8"]],
  ])("rejects replay with %s (#8267)", (_label, addresses) => {
    expect(() => replayTrustedPrivateEndpoint("mcp.corp.example", addresses)).toThrow(
      /recorded address pin/,
    );
  });
});
