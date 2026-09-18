// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { assertNoAmbiguousMcpCredentialTarget } from "./mcp-bridge-state";

const existing: McpSourceEntry = {
  server: "alpha",
  agent: "openclaw",
  adapter: "openclaw-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["AAA_TOK"],
  providerName: "sandbox-mcp-alpha",
  policyName: "mcp-bridge-alpha",
};

describe("managed MCP credential target ambiguity", () => {
  it("rejects a second credential binding for the same endpoint (#11895)", () => {
    expect(() =>
      assertNoAmbiguousMcpCredentialTarget(
        { alpha: existing },
        "beta",
        existing.url,
        "sandbox-mcp-beta",
      ),
    ).toThrow(/cannot safely choose between credentials for an indistinguishable endpoint/);
  });

  it("allows separately credentialed servers at distinct endpoints (#11895)", () => {
    expect(() =>
      assertNoAmbiguousMcpCredentialTarget(
        { alpha: existing },
        "beta",
        "https://mcp.example.com/api/",
        "sandbox-mcp-beta",
      ),
    ).not.toThrow();
  });

  it("allows unauthenticated aliases because they do not compete for credentials (#11895)", () => {
    const anonymous = { ...existing, env: [], providerName: undefined };
    expect(() =>
      assertNoAmbiguousMcpCredentialTarget({ alpha: anonymous }, "beta", anonymous.url, undefined),
    ).not.toThrow();
  });
});
