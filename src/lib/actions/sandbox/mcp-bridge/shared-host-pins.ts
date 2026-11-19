// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpSourceEntry } from "../mcp-bridge-contracts";
import {
  parseMcpUrlWithValidatedTarget,
  type McpBridgeTargetValidation,
} from "../mcp-bridge-url-validation";

export type McpSharedHostPinAlignment =
  | {
      ok: true;
      target: McpBridgeTargetValidation;
      /** Servers whose recorded public pins are reused. */
      reusedFrom: string[];
    }
  | {
      ok: false;
      /** Operator-facing reason the operation cannot proceed; the caller reports it as a usage error. */
      message: string;
    };

interface PinGroup {
  pins: string[];
  servers: string[];
  trustedPrivate: boolean;
}

function endpointAuthority(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.hostname.toLowerCase()}:${parsed.port || "443"}`;
  } catch {
    return null;
  }
}

function sortedPins(addresses: readonly string[]): string[] {
  return [...new Set(addresses.map((address) => address.toLowerCase()))].sort();
}

function describePins(pins: readonly string[]): string {
  return pins.join(", ");
}

function describeServers(servers: readonly string[]): string {
  return servers.map((server) => `'${server}'`).join(", ");
}

/** Align policy targets with recorded pins on the same host and port before mutation. */
export function alignMcpTargetWithSharedHostPins(options: {
  operation: "add" | "update" | "refresh";
  sandboxName: string;
  server: string;
  url: string;
  target: McpBridgeTargetValidation;
  bridges: Readonly<Record<string, McpSourceEntry>>;
}): McpSharedHostPinAlignment {
  const { operation, sandboxName, server, url, target, bridges } = options;
  const action = { add: "added", update: "updated", refresh: "refreshed" }[operation];
  const authority = endpointAuthority(url);
  if (!authority) return { ok: true, target, reusedFrom: [] };

  const recovery = `Before removing registrations with \`nemoclaw ${sandboxName} mcp remove <server>\`, follow https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/manage-sandboxes/mcp-servers/manage-mcp-servers#rotate-a-credential to record current denied-tool selectors and re-export the affected credential variables. Removal preserves providers. Perform explicit provider cleanup only after confirming no other sandbox uses them. Re-add with the recorded selectors.`;
  const groups = new Map<string, PinGroup>();
  for (const entry of Object.values(bridges)) {
    if (entry.server === server) continue;
    if (entry.policyEndpointConflict) {
      return {
        ok: false,
        message: `MCP server '${server}' was not ${action}: the live policy endpoint for managed server '${entry.server}' differs from its registered URL. Resolve that conflict before reconciling address pins on ${authority}. ${recovery}`,
      };
    }
    if (!entry.allowedIps?.length || endpointAuthority(entry.url) !== authority) continue;
    const pins = sortedPins(entry.allowedIps);
    const key = pins.join(",");
    const group = groups.get(key) ?? { pins, servers: [], trustedPrivate: false };
    group.servers.push(entry.server);
    group.trustedPrivate ||= Boolean(entry.trustedPrivateHost);
    groups.set(key, group);
  }
  if (groups.size === 0) return { ok: true, target, reusedFrom: [] };

  const [firstGroup, ...otherGroups] = [...groups.values()];
  if (otherGroups.length > 0) {
    const recorded = [firstGroup, ...otherGroups]
      .map((group) => `${describeServers(group.servers)}: ${describePins(group.pins)}`)
      .join("; ");
    return {
      ok: false,
      message: `MCP server '${server}' was not ${action}: managed servers on ${authority} already record different address pins (${recorded}). OpenShell rejects endpoints that share a host and port but list different allowed IPs. ${recovery}`,
    };
  }

  const requested = sortedPins(target.addresses);
  if (requested.join(",") === firstGroup.pins.join(","))
    return { ok: true, target, reusedFrom: [] };

  if (firstGroup.trustedPrivate || target.trustedPrivateHost) {
    return {
      ok: false,
      message: `MCP server '${server}' was not ${action}: it resolves to ${describePins(requested)} on ${authority}, but ${describeServers(firstGroup.servers)} record${firstGroup.servers.length === 1 ? "s" : ""} ${describePins(firstGroup.pins)}, and OpenShell rejects endpoints that share a host and port but list different allowed IPs. NemoClaw does not reuse or replace trusted-private pins on its own. ${recovery}`,
    };
  }

  if (operation === "refresh") {
    return {
      ok: false,
      message: `MCP server '${server}' was not refreshed: ${authority} is shared with ${describeServers(firstGroup.servers)}, which record ${describePins(firstGroup.pins)}. Refreshing only this server to ${describePins(requested)} would create conflicting address pins. ${recovery}`,
    };
  }

  const reused = { addresses: [...firstGroup.pins] };
  // The recorded pins were validated when they were written; check them again
  // so a tampered or hand-edited policy cannot widen a new server's egress.
  parseMcpUrlWithValidatedTarget(url, reused);
  return { ok: true, target: reused, reusedFrom: [...firstGroup.servers] };
}
