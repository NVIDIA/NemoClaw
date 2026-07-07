// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { type DnsLookupAll, resolveHostAddresses } from "./resolve";

describe("DNS resolver adapter", () => {
  it("requests all addresses in resolver order through the injected lookup", async () => {
    const addresses = [
      { address: "203.0.113.10", family: 4 },
      { address: "2001:db8::10", family: 6 },
    ];
    const lookup = vi.fn<DnsLookupAll>().mockResolvedValue(addresses);

    await expect(resolveHostAddresses("mcp.example.test", lookup)).resolves.toEqual(addresses);
    expect(lookup).toHaveBeenCalledWith("mcp.example.test", {
      all: true,
      verbatim: true,
    });
  });
});
