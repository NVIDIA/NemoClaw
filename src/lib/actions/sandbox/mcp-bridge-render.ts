// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../../agent/defs";
import type { McpBridgeStatus } from "./mcp-bridge-contracts";

export function renderMcpBridgeList(
  sandboxName: string,
  statuses: McpBridgeStatus[],
  agent: AgentDefinition,
): void {
  console.log("");
  if (agent.mcpCapability.support !== "bridge") {
    console.log(`  MCP support: disabled for ${agent.displayName}`);
    if (agent.mcpCapability.reason) console.log(`  ${agent.mcpCapability.reason}`);
  }
  if (statuses.length === 0) {
    console.log(`  No MCP servers for sandbox '${sandboxName}'.`);
    console.log("");
    return;
  }
  console.log(`  MCP servers for sandbox '${sandboxName}':`);
  for (const status of statuses) {
    const policy = status.policy.gatewayPresent ? "policy" : "policy?";
    const provider =
      status.provider.registryPresent &&
      status.provider.gatewayPresent &&
      status.provider.attached === true &&
      status.provider.credentialReady === true
        ? "provider"
        : "provider?";
    const env = status.env.names.length > 0 ? status.env.names.join(", ") : "(none)";
    console.log(
      `    ${status.server.padEnd(18)} ${policy.padEnd(8)} ${provider.padEnd(10)} env: ${env}${status.addState ? `  add:${status.addState}` : ""}`,
    );
  }
  console.log("");
}

export function renderMcpBridgeStatus(
  sandboxName: string,
  statuses: McpBridgeStatus[],
  agent: AgentDefinition,
): void {
  if (statuses.length === 0) {
    console.log("");
    console.log(`  MCP servers for sandbox '${sandboxName}': none`);
    console.log(`    agent: ${agent.name}`);
    console.log(`    support: ${agent.mcpCapability.support}`);
    if (agent.mcpCapability.reason) console.log(`    reason: ${agent.mcpCapability.reason}`);
    console.log("");
    return;
  }
  for (const status of statuses) {
    console.log("");
    console.log(`  MCP server: ${status.server}`);
    console.log(`    agent: ${status.agent}`);
    console.log(`    support: ${status.support.mode}`);
    if (status.support.reason) console.log(`    reason: ${status.support.reason}`);
    if (status.url) console.log(`    endpoint: ${status.url}`);
    if (status.addState) console.log(`    add transaction: incomplete (${status.addState})`);
    console.log(
      `    provider: ${status.provider.registryPresent ? status.provider.name : "(none)"}`,
    );
    console.log(
      `    provider attached: ${status.provider.attached === null ? "unknown" : status.provider.attached ? "yes" : "no"}`,
    );
    console.log(
      `    provider credentials: ${status.provider.credentialReady === null ? "unknown" : status.provider.credentialReady ? "ready" : "drifted or missing"}`,
    );
    if (status.provider.detail) console.log(`    provider detail: ${status.provider.detail}`);
    console.log(
      `    policy: ${status.policy.gatewayPresent === null ? "unknown" : status.policy.gatewayPresent ? "present" : "missing"}`,
    );
    console.log(
      `    adapter: ${status.adapter.registered === null ? "unknown" : status.adapter.registered ? "registered" : "missing"}`,
    );
    console.log(
      `    env: ${status.env.ready ? "ready" : status.env.missing.length > 0 ? `missing ${status.env.missing.join(", ")}` : "not ready"}`,
    );
    const resolution = status.provider.credentialResolution;
    if (resolution) {
      console.log(
        `    credential resolution: ${
          resolution.ok === true
            ? `verified (HTTP ${resolution.httpStatus})`
            : resolution.ok === false
              ? `FAILED (HTTP ${resolution.httpStatus})`
              : `unknown${resolution.detail ? ` (${resolution.detail})` : ""}`
        }`,
      );
    }
    for (const warning of status.warnings) console.log(`    warning: ${warning}`);
  }
  console.log("");
}
