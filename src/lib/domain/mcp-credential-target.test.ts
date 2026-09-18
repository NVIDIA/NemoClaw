// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { findAmbiguousMcpCredentialTarget } from "./mcp-credential-target";

describe("managed MCP credential targets", () => {
  it("finds distinct credential providers bound to the same endpoint", () => {
    expect(
      findAmbiguousMcpCredentialTarget([
        { server: "alpha", url: "https://mcp.example.test/", providerName: "alpha-provider" },
        { server: "beta", url: "https://mcp.example.test/", providerName: "beta-provider" },
      ]),
    ).toMatchObject({ entry: { server: "beta" }, conflict: { server: "alpha" } });
  });

  it("treats query-only URL variants as the same enforced endpoint", () => {
    expect(
      findAmbiguousMcpCredentialTarget([
        {
          server: "alpha",
          url: "https://mcp.example.test/mcp?tenant=alpha",
          providerName: "alpha-provider",
        },
        {
          server: "beta",
          url: "https://mcp.example.test/mcp?tenant=beta",
          providerName: "beta-provider",
        },
      ]),
    ).toMatchObject({ entry: { server: "beta" }, conflict: { server: "alpha" } });
  });

  it("allows distinct endpoints and unauthenticated aliases", () => {
    expect(
      findAmbiguousMcpCredentialTarget([
        { server: "alpha", url: "https://alpha.example.test/", providerName: "alpha-provider" },
        { server: "beta", url: "https://beta.example.test/", providerName: "beta-provider" },
      ]),
    ).toBeNull();
    expect(
      findAmbiguousMcpCredentialTarget([
        { server: "alpha", url: "https://mcp.example.test/" },
        { server: "beta", url: "https://mcp.example.test/" },
      ]),
    ).toBeNull();
    expect(
      findAmbiguousMcpCredentialTarget([
        { server: "alpha", url: "https://mcp.example.test/" },
        { server: "beta", url: "https://mcp.example.test/", providerName: "beta-provider" },
      ]),
    ).toBeNull();
  });
});
