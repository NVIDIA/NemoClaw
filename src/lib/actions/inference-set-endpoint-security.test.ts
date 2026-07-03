// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { rewriteConfigUrlsWithDnsPinning } from "../sandbox/config";
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

  it("fails closed for DNS-backed HTTPS endpoints until runtime-aware pinning exists", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

    await expect(
      normalizeCustomEndpointUrl("https://public-endpoint.example/v1/", (value) =>
        rewriteConfigUrlsWithDnsPinning(value, lookup),
      ),
    ).rejects.toThrow(/DNS-backed HTTPS URLs are not supported/);
  });
});
