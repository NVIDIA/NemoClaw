// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  inspectExactManagedMcpPolicies as inspectRegisteredManagedMcpPolicies,
  MCP_BRIDGE_POLICY_SOURCE,
} from "../actions/sandbox/mcp-bridge-policy";
import {
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
} from "../actions/sandbox/mcp-bridge-policy-render";
import type { SandboxEntry } from "../state/registry";
import { composeManagedMcpPolicies } from "./mcp-policy-transition";

const ADAPTER = "hermes-config";

function registeredPolicy(
  server: string,
  address: string,
): NonNullable<SandboxEntry["customPolicies"]>[number] {
  return {
    name: buildMcpBridgePolicyName(server),
    content: buildMcpBridgePolicyYaml(server, `https://${server}.example.com/mcp`, ADAPTER, [
      address,
    ]),
    sourcePath: MCP_BRIDGE_POLICY_SOURCE,
  };
}

function bridge(server: string): NonNullable<NonNullable<SandboxEntry["mcp"]>["bridges"]>[string] {
  return {
    server,
    agent: "hermes",
    adapter: ADAPTER,
    url: `https://${server}.example.com/mcp`,
    env: ["MCP_SECRET"],
    providerName: `sandbox-mcp-${server}`,
    providerId: `provider-${server}`,
    policyName: buildMcpBridgePolicyName(server),
    addedAt: "2026-07-30T00:00:00.000Z",
  };
}

function sandboxWithPolicies(
  policies: Array<ReturnType<typeof registeredPolicy>>,
  bridgeServers = policies.map((policy) => policy.name.replace(/^mcp-bridge-/, "")),
): SandboxEntry {
  return {
    name: "alpha",
    agent: "hermes",
    customPolicies: policies,
    mcp: {
      bridges: Object.fromEntries(bridgeServers.map((server) => [server, bridge(server)])),
    },
  };
}

function networkEntry(content: string, server: string): unknown {
  return YAML.parse(content).network_policies[buildMcpBridgePolicyKey(server)];
}

function livePolicy(
  entries: Array<{ content: string; server: string }>,
  extra: Record<string, unknown> = {},
): string {
  return YAML.stringify({
    version: 1,
    network_policies: {
      ...extra,
      ...Object.fromEntries(
        entries.map(({ content, server }) => [
          buildMcpBridgePolicyKey(server),
          networkEntry(content, server),
        ]),
      ),
    },
  });
}

function inspectExactManagedMcpPolicies(sandbox: SandboxEntry, livePolicyYaml: string) {
  return inspectRegisteredManagedMcpPolicies("alpha", livePolicyYaml, {
    getSandbox: () => sandbox,
  });
}

describe("managed MCP Shields policy transitions (#7952)", () => {
  it("admits only canonical committed registrations that exactly match the live policy", () => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    const sandbox = sandboxWithPolicies([alpha]);

    const exact = inspectExactManagedMcpPolicies(
      sandbox,
      livePolicy([{ content: alpha.content, server: "alpha" }], {
        unrelated_live_entry: { endpoints: [{ host: "unrelated.example.com" }] },
      }),
    );

    expect(exact).toEqual([
      expect.objectContaining({
        key: "mcp_bridge_alpha",
        policyName: "mcp-bridge-alpha",
        server: "alpha",
      }),
    ]);
  });

  it.each([
    {
      label: "pending policy content",
      mutate: (sandbox: SandboxEntry) => {
        sandbox.customPolicies![0]!.pendingContent = sandbox.customPolicies![0]!.content;
      },
      expected: /incomplete policy transition/,
    },
    {
      label: "an orphaned generated registration",
      mutate: (sandbox: SandboxEntry) => {
        sandbox.customPolicies!.push(registeredPolicy("orphan", "1.1.1.1"));
      },
      expected: /no committed managed bridge ownership/,
    },
    {
      label: "an incomplete bridge add",
      mutate: (sandbox: SandboxEntry) => {
        sandbox.mcp!.bridges.alpha!.addState = "prepared";
      },
      expected: /lifecycle transition is incomplete/,
    },
  ])("fails closed on $label", ({ mutate, expected }) => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    const sandbox = sandboxWithPolicies([alpha]);
    mutate(sandbox);

    expect(() =>
      inspectExactManagedMcpPolicies(
        sandbox,
        livePolicy(
          (sandbox.customPolicies ?? []).map((policy) => ({
            content: policy.content,
            server: policy.name.replace(/^mcp-bridge-/, ""),
          })),
        ),
      ),
    ).toThrow(expected);
  });

  it("fails closed when the live policy differs from the ownership record", () => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    const drifted = registeredPolicy("alpha", "1.1.1.1");

    expect(() =>
      inspectExactManagedMcpPolicies(
        sandboxWithPolicies([alpha]),
        livePolicy([{ content: drifted.content, server: "alpha" }]),
      ),
    ).toThrow(/drifted from its ownership record/);
  });

  it("retains additions while restoring the restrictive snapshot", () => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    const beta = registeredPolicy("beta", "1.1.1.1");
    const current = inspectExactManagedMcpPolicies(
      sandboxWithPolicies([alpha, beta]),
      livePolicy([
        { content: alpha.content, server: "alpha" },
        { content: beta.content, server: "beta" },
      ]),
    );
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: {
        restrictive_baseline: { endpoints: [{ host: "baseline.example.com" }] },
        mcp_bridge_alpha: networkEntry(alpha.content, "alpha"),
      },
    });

    const restored = YAML.parse(composeManagedMcpPolicies(snapshot, current, ["mcp_bridge_alpha"]));

    expect(Object.keys(restored.network_policies).sort()).toEqual([
      "mcp_bridge_alpha",
      "mcp_bridge_beta",
      "restrictive_baseline",
    ]);
  });

  it("does not resurrect a managed MCP policy removed while Shields are down", () => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: {
        restrictive_baseline: { endpoints: [{ host: "baseline.example.com" }] },
        mcp_bridge_alpha: networkEntry(alpha.content, "alpha"),
      },
    });

    const restored = YAML.parse(composeManagedMcpPolicies(snapshot, [], ["mcp_bridge_alpha"]));

    expect(restored.network_policies).toEqual({
      restrictive_baseline: { endpoints: [{ host: "baseline.example.com" }] },
    });
  });

  it("replaces a stale snapshot entry with the current exact registration", () => {
    const oldAlpha = registeredPolicy("alpha", "8.8.8.8");
    const currentAlpha = registeredPolicy("alpha", "1.1.1.1");
    const current = inspectExactManagedMcpPolicies(
      sandboxWithPolicies([currentAlpha]),
      livePolicy([{ content: currentAlpha.content, server: "alpha" }]),
    );
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: {
        mcp_bridge_alpha: networkEntry(oldAlpha.content, "alpha"),
      },
    });

    const restored = YAML.parse(composeManagedMcpPolicies(snapshot, current, ["mcp_bridge_alpha"]));

    expect(restored.network_policies.mcp_bridge_alpha).toEqual(
      networkEntry(currentAlpha.content, "alpha"),
    );
  });
});
