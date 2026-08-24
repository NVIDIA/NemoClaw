// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preflightMcpEntryTargets: vi.fn(),
}));

vi.mock("../mcp-bridge-provider", () => ({
  preflightMcpEntryTargets: mocks.preflightMcpEntryTargets,
}));

import { buildMcpBridgePolicyName } from "../mcp-bridge-policy";
import { resolveManagedMcpPolicyRequirementContents } from "./mcp-requirements";

describe("policy-authority managed MCP requirements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.preflightMcpEntryTargets.mockResolvedValue(
      new Map([["github", { addresses: ["8.8.8.8"] }]]),
    );
  });

  it("derives the exact requirement from the retained bridge and validated pins (#9833)", async () => {
    const requirements = await resolveManagedMcpPolicyRequirementContents(
      {
        name: "alpha",
        agent: "openclaw",
        mcp: {
          bridges: {
            github: {
              server: "github",
              agent: "openclaw",
              adapter: "mcporter",
              url: "https://mcp.example.test/mcp",
              env: ["GITHUB_TOKEN"],
              providerName: "alpha-mcp-github",
              providerId: "provider-1",
              policyName: buildMcpBridgePolicyName("github"),
              addedAt: "2026-08-20T00:00:00.000Z",
            },
          },
        },
      },
      "rebuild sandbox 'alpha'",
    );

    expect(requirements).toHaveLength(1);
    expect(YAML.parse(requirements[0] ?? "")).toMatchObject({
      network_policies: {
        mcp_bridge_github: {
          endpoints: [
            expect.objectContaining({
              allowed_ips: ["8.8.8.8"],
              credential_binding: { provider: "alpha-mcp-github" },
            }),
          ],
        },
      },
    });
  });
});
