// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AgentMcpAdapter } from "../../agent/defs";
import { isTrustedPrivateEndpointCapability } from "../../security/trusted-private-endpoint";
import type { McpBridgeEntry } from "../../state/registry";
import { assertMcpBridgePolicyTarget } from "./mcp-bridge-policy";
import { preflightMcpEntryTargets } from "./mcp-bridge-provider";

const adapters: Array<{ adapter: AgentMcpAdapter; agent: string }> = [
  { adapter: "mcporter", agent: "openclaw" },
  { adapter: "hermes-config", agent: "hermes" },
  { adapter: "deepagents-config", agent: "deepagents" },
];

function privateEntry(adapter: AgentMcpAdapter, agent: string): McpBridgeEntry {
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
    addedAt: "2026-08-04T00:00:00.000Z",
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
    const entry = privateEntry("mcporter", "openclaw");
    entry.allowedIps = ["10.20.30.40", "8.8.8.8"];

    await expect(preflightMcpEntryTargets([entry])).rejects.toThrow(
      /invalid durable trusted-private intent/,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects durable private intent for a different stored URL host (#8267)", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ambient DNS used"));
    const entry = privateEntry("mcporter", "openclaw");
    entry.url = "https://other.corp.example/mcp";

    await expect(preflightMcpEntryTargets([entry])).rejects.toThrow(
      /trusted-private intent for a host that does not match its stored URL/,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("resumes an incomplete private add from recorded pins without ambient DNS (#8267)", {
    timeout: 40_000,
  }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-private-mcp-add-replay-"));
    const sourceRequireHook = path.resolve("test/helpers/onboard-script-mocks.cjs");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
delete process.env.LOCAL_MCP_TOKEN;
const dns = require("node:dns/promises");
let dnsCalls = 0;
dns.lookup = async () => { dnsCalls += 1; throw new Error("ambient DNS used"); };
const registry = require("./src/lib/state/registry.js");
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw-9090",
  gatewayPort: 9090,
  mcp: { bridges: { local: {
    server: "local",
    agent: "openclaw",
    adapter: "mcporter",
    url: "https://mcp.corp.example/mcp",
    env: ["LOCAL_MCP_TOKEN"],
    trustedPrivateHost: "mcp.corp.example",
    allowedIps: ["10.20.30.40"],
    providerName: "alpha-mcp-local",
    policyName: "mcp-bridge-local",
    addedAt: "2026-08-04T00:00:00.000Z",
    addState: "prepared",
  } } },
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.addMcpBridge("alpha", {
  server: "local",
  url: "https://mcp.corp.example/mcp",
  env: [{ name: "LOCAL_MCP_TOKEN" }],
  trustedPrivateHosts: ["mcp.corp.example"],
}).then(
  () => process.exit(9),
  (error) => process.stdout.write(
    JSON.stringify({ message: error.message, dnsCalls }),
    () => process.exit(0),
  ),
);
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${sourceRequireHook}`]
          .filter(Boolean)
          .join(" "),
      },
      timeout: 30_000,
    });
    fs.rmSync(home, { recursive: true, force: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      message:
        "Host environment variable 'LOCAL_MCP_TOKEN' is required to create MCP provider 'alpha-mcp-local'.",
      dnsCalls: 0,
    });
  });
});
