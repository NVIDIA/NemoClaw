// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  assertEndpointResolvesPublic,
  buildResolvePinArgs,
  type EndpointDnsLookupFn,
} from "./endpoint-ssrf-preflight";

const resolverTo = (address: string): EndpointDnsLookupFn =>
  vi.fn(async () => [{ address, family: address.includes(":") ? 6 : 4 }]);

describe("assertEndpointResolvesPublic (#6293)", () => {
  it("allows a public hostname that resolves to a public address without ever needing a private check", async () => {
    const lookup = resolverTo("93.184.216.34");
    const result = await assertEndpointResolvesPublic("https://vllm.example/v1", lookup);
    expect(result.ok).toBe(true);
    expect(lookup).toHaveBeenCalledWith("vllm.example", { all: true });
  });

  it.each([
    "10.0.0.8",
    "169.254.169.254",
    "192.168.1.10",
    "172.16.0.5",
    "127.0.0.1",
  ])("refuses a public hostname that resolves to the private/reserved address %s (#6293)", async (privateAddress) => {
    const lookup = resolverTo(privateAddress);
    const result = await assertEndpointResolvesPublic("https://public-name.example/v1", lookup);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(privateAddress);
  });

  it("refuses a literal private endpoint before resolving anything (#6293)", async () => {
    const lookup = vi.fn<EndpointDnsLookupFn>();
    const result = await assertEndpointResolvesPublic("http://10.0.0.1/v1", lookup);
    expect(result.ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "http://127.0.0.1:8000/v1",
    "http://localhost:8000/v1",
    "http://[::1]:8000/v1",
  ])("allows the explicit loopback endpoint %s without resolving (#6293)", async (endpointUrl) => {
    const lookup = vi.fn<EndpointDnsLookupFn>();
    const result = await assertEndpointResolvesPublic(endpointUrl, lookup);
    expect(result.ok).toBe(true);
    expect(result.addresses).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("allows a public IP literal without resolving (#6293)", async () => {
    const lookup = vi.fn<EndpointDnsLookupFn>();
    const result = await assertEndpointResolvesPublic("https://93.184.216.34/v1", lookup);
    expect(result.ok).toBe(true);
    expect(result.addresses).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps dual-stack addresses in one curl --resolve mapping (#6293)", () => {
    expect(
      buildResolvePinArgs("https://vllm.example/v1/models", [
        "93.184.216.34",
        "2606:2800:220:1:248:1893:25c8:1946",
      ]),
    ).toEqual(["--resolve", "vllm.example:443:93.184.216.34,[2606:2800:220:1:248:1893:25c8:1946]"]);
  });

  it("fails closed when the resolver throws (#6293)", async () => {
    const lookup: EndpointDnsLookupFn = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    const result = await assertEndpointResolvesPublic("https://unresolvable.example/v1", lookup);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("cannot resolve");
  });

  it("fails closed when the resolver returns no addresses (#6293)", async () => {
    const lookup: EndpointDnsLookupFn = vi.fn(async () => []);
    const result = await assertEndpointResolvesPublic("https://empty.example/v1", lookup);
    expect(result.ok).toBe(false);
  });

  it("refuses a malformed endpoint URL (#6293)", async () => {
    const result = await assertEndpointResolvesPublic("not a url", resolverTo("93.184.216.34"));
    expect(result.ok).toBe(false);
  });

  it.each([
    "https://inference.local/v1",
    "http://host.openshell.internal:8000/v1",
    "http://host.docker.internal:11434/v1",
    "http://host.containers.internal:11434/v1",
  ])("exempts the OpenShell-managed alias %s without resolving or pinning (#6293)", async (endpointUrl) => {
    const lookup = vi.fn<EndpointDnsLookupFn>();
    const result = await assertEndpointResolvesPublic(endpointUrl, lookup);
    expect(result.ok).toBe(true);
    // Managed aliases need no --resolve pin, but the defined empty capability
    // still forces credentialed host probes to bypass ambient proxies.
    expect(result.addresses).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });
});
