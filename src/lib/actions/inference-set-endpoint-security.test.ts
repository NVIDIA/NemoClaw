// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { rewriteConfigUrlsWithDnsPinning } from "../sandbox/config";
import { normalizeCustomEndpointUrl } from "./inference-set";

describe("custom inference endpoint DNS pinning", () => {
  it("pins validated public HTTP endpoints before they become durable metadata", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

    await expect(
      normalizeCustomEndpointUrl("http://public-endpoint.example/v1/", (value) =>
        rewriteConfigUrlsWithDnsPinning(value, lookup),
      ),
    ).resolves.toBe("http://93.184.216.34/v1");
    expect(lookup).toHaveBeenCalledWith("public-endpoint.example", { all: true });
  });

  it("preserves a validated HTTPS hostname for certificate verification", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

    await expect(
      normalizeCustomEndpointUrl("https://public-endpoint.example/v1/", (value) =>
        rewriteConfigUrlsWithDnsPinning(value, lookup),
      ),
    ).resolves.toBe("https://public-endpoint.example/v1");
  });
});
