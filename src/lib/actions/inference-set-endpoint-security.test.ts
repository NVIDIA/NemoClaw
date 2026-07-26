// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { rewriteConfigUrlsWithDnsPinning } from "../sandbox/config";
import type { ConfigValue } from "../security/credential-filter";
import { normalizeCustomEndpointUrl } from "./inference-set";

describe("custom inference endpoint DNS pinning", () => {
  it.each([
    1024, 65535,
  ])("allows the exact OpenShell bridge exemption at port %i without DNS rewriting", async (port) => {
    const rewriteUrl = vi.fn(async () => {
      throw new Error("bridge exemption unexpectedly reached DNS validation");
    });

    await expect(
      normalizeCustomEndpointUrl(`http://host.openshell.internal:${port}/v1/`, rewriteUrl),
    ).resolves.toBe(`http://host.openshell.internal:${port}/v1`);
    expect(rewriteUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["no explicit port", "http://host.openshell.internal/v1"],
    ["privileged port", "http://host.openshell.internal:1023/v1"],
    ["HTTPS bridge", "https://host.openshell.internal:1234/v1"],
    ["localhost", "http://localhost:1234/v1"],
    ["loopback", "http://127.0.0.1:1234/v1"],
    ["RFC1918", "http://10.0.0.1:1234/v1"],
    ["non-allowlisted internal DNS", "http://other.internal:1234/v1"],
  ])("rejects the adjacent %s bypass shape", async (_kind, endpointUrl) => {
    const lookup = vi.fn(async () => [{ address: "10.0.0.8", family: 4 }]);

    await expect(
      normalizeCustomEndpointUrl(endpointUrl, (value) =>
        rewriteConfigUrlsWithDnsPinning(value, lookup),
      ),
    ).rejects.toThrow(/endpoint-url is not allowed:.*private\/internal address/i);
  });

  it("pins validated public HTTP endpoints before they become durable metadata", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

    await expect(
      normalizeCustomEndpointUrl("http://public-endpoint.example/v1/", (value) =>
        rewriteConfigUrlsWithDnsPinning(value, lookup),
      ),
    ).resolves.toBe("http://93.184.216.34/v1");
    expect(lookup).toHaveBeenCalledWith("public-endpoint.example", { all: true });
  });

  it.each([
    ["userinfo", "https://user:secret@public-endpoint.example/v1"],
    ["query", "https://public-endpoint.example/v1?api_key=secret"],
    ["fragment", "https://public-endpoint.example/v1#secret"],
  ])("rejects a source endpoint with %s instead of silently stripping it", async (_kind, endpointUrl) => {
    const rewriteUrl = vi.fn(async (value: ConfigValue) => value);
    const ensureAdapter = vi.fn(async () => "http://host.openshell.internal:11438/route/test");

    await expect(
      normalizeCustomEndpointUrl(endpointUrl, rewriteUrl, ensureAdapter),
    ).rejects.toThrow("without userinfo, query, or fragment components");
    expect(rewriteUrl).not.toHaveBeenCalled();
    expect(ensureAdapter).not.toHaveBeenCalled();
  });

  it("fails closed for DNS-backed HTTPS endpoints until runtime-aware pinning exists", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

    await expect(
      normalizeCustomEndpointUrl("https://public-endpoint.example/v1/", (value) =>
        rewriteConfigUrlsWithDnsPinning(value, lookup),
      ),
    ).rejects.toThrow(/DNS-backed HTTPS URLs are not supported/);
  });

  it("adds the HTTPS Pin Runtime adapter hint only at the inference-set call site, not in the generic config validator's own message (#6141)", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

    // The generic validator (also used by plain `config set` for arbitrary
    // fields) must not mention inference set or the adapter -- it has no way
    // to know the field it's validating is an inference endpoint.
    await expect(
      rewriteConfigUrlsWithDnsPinning("https://public-endpoint.example/v1/", lookup),
    ).rejects.toThrow(/^(?!.*(?:inference set|HTTPS Pin Runtime adapter)).*$/is);

    // normalizeCustomEndpointUrl is only ever called for `inference set
    // --endpoint-url`, so it appends the adapter-specific hint itself.
    await expect(
      normalizeCustomEndpointUrl("https://public-endpoint.example/v1/", (value) =>
        rewriteConfigUrlsWithDnsPinning(value, lookup),
      ),
    ).rejects.toThrow(/HTTPS Pin Runtime adapter/);
  });
});
