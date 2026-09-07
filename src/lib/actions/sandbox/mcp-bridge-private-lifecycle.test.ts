// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import dns from "node:dns/promises";

import { describe, expect, it, vi } from "vitest";

import type { AgentMcpAdapter } from "../../agent/defs";
import { isTrustedPrivateEndpointCapability } from "../../security/trusted-private-endpoint";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { assertMcpBridgePolicyTarget } from "./mcp-bridge-policy";
import { preflightMcpEntryTargets } from "./mcp-bridge-provider";

const adapters: Array<{ adapter: AgentMcpAdapter; agent: string }> = [
  { adapter: "openclaw-config", agent: "openclaw" },
  { adapter: "hermes-config", agent: "hermes" },
  { adapter: "deepagents-config", agent: "deepagents" },
];

function privateEntry(adapter: AgentMcpAdapter, agent: string): McpSourceEntry {
  return {
    server: "local",
    agent,
    adapter,
    url: "https://mcp.corp.internal/mcp",
    env: ["LOCAL_MCP_TOKEN"],
    trustedPrivateHost: "mcp.corp.internal",
    allowedIps: ["10.20.30.40", "fd00::40"],
    providerName: "alpha-mcp-local",
    providerId: "11111111-2222-4333-8444-555555555555",
    policyName: "mcp-bridge-local",
  };
}

describe("trusted-private MCP lifecycle replay", () => {
  it.each(adapters)("replays recorded pins without ambient DNS for $agent (#8267)", async ({
    adapter,
    agent,
  }) => {
    const lookup = vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ambient DNS used"));
    const entry = privateEntry(adapter, agent);

    const targets = await preflightMcpEntryTargets([entry]);
    const target = targets.get(entry.server);

    expect(lookup).not.toHaveBeenCalled();
    expect(target?.addresses).toEqual(entry.allowedIps);
    expect(target?.trustedPrivateHost).toBe(entry.trustedPrivateHost);
    expect(isTrustedPrivateEndpointCapability(target?.trustedPrivateCapability)).toBe(true);
    expect(target && assertMcpBridgePolicyTarget(entry, target)).toEqual(entry.allowedIps);
  });

  it.each(adapters)("replays a direct private IPv4 target for $agent (#8267)", async ({
    adapter,
    agent,
  }) => {
    const lookup = vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ambient DNS used"));
    const entry = privateEntry(adapter, agent);
    entry.url = "https://10.20.30.40/mcp";
    entry.trustedPrivateHost = "10.20.30.40";
    entry.allowedIps = ["10.20.30.40"];

    const target = (await preflightMcpEntryTargets([entry])).get(entry.server);

    expect(lookup).not.toHaveBeenCalled();
    expect(target).toMatchObject({
      addresses: ["10.20.30.40"],
      trustedPrivateHost: "10.20.30.40",
    });
    expect(target && assertMcpBridgePolicyTarget(entry, target)).toEqual(["10.20.30.40"]);
  });

  it("rejects invalid durable private pins without consulting DNS (#8267)", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ambient DNS used"));
    const entry = privateEntry("openclaw-config", "openclaw");
    entry.allowedIps = ["10.20.30.40", "8.8.8.8"];

    await expect(preflightMcpEntryTargets([entry])).rejects.toThrow(
      /invalid durable trusted-private intent/,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects durable private intent for a different stored URL host (#8267)", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ambient DNS used"));
    const entry = privateEntry("openclaw-config", "openclaw");
    entry.url = "https://other.corp.example/mcp";

    await expect(preflightMcpEntryTargets([entry])).rejects.toThrow(
      /trusted-private intent for a host that does not match its stored URL/,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

});
