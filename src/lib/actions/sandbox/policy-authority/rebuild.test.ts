// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preflightMcpEntryTargets: vi.fn(),
}));

vi.mock("../mcp-bridge-provider", () => ({
  preflightMcpEntryTargets: mocks.preflightMcpEntryTargets,
}));

import * as policies from "../../../policy";
import * as onboardSession from "../../../state/onboard-session";
import * as registry from "../../../state/registry";
import { buildMcpBridgePolicyName } from "../mcp-bridge-policy";
import type { RebuildSandboxEntry } from "../rebuild-flow-helpers";
import { makePreparedRecoveryManifest } from "../rebuild-flow-test-fixtures";
import { qualifyRebuildPolicyAuthority, revalidateRebuildPolicyAuthority } from "./rebuild";

const CUSTOM_POLICY = `
network_policies:
  custom-api:
    endpoints:
      - host: custom.example.com
        port: 443
`;

function externalEffectivePolicy(includeCustom = true): Record<string, unknown> {
  const baseline = policies.resolveAgentBaselinePolicy("openclaw")!;
  const parsedBaseline = YAML.parse(baseline.content) as Record<string, unknown> & {
    network_policies: Record<string, unknown>;
  };
  const parsedCustom = YAML.parse(CUSTOM_POLICY) as {
    network_policies: Record<string, unknown>;
  };
  return {
    ...parsedBaseline,
    network_policies: {
      ...parsedBaseline.network_policies,
      ...(includeCustom ? parsedCustom.network_policies : {}),
    },
  };
}

function sandboxEntry(
  policyAuthority: RebuildSandboxEntry["policyAuthority"],
): RebuildSandboxEntry {
  return {
    name: "alpha",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    policyAuthority,
    policies: [],
    policyTier: "restricted",
    customPolicies: [{ name: "custom-api", content: CUSTOM_POLICY, sourcePath: "/tmp/policy" }],
  } as RebuildSandboxEntry;
}

describe("rebuild policy authority preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.preflightMcpEntryTargets.mockResolvedValue(
      new Map([["github", { addresses: ["8.8.8.8"] }]]),
    );
    vi.spyOn(onboardSession, "loadSession").mockReturnValue(null);
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue([]);
    vi.spyOn(registry, "getDisabledMessagingChannelsFromEntry").mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("verifies every rebuild policy requirement before accepting external authority (#9833)", async () => {
    const entry = sandboxEntry("externally-managed");
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: externalEffectivePolicy(),
    };
    const updateSandbox = vi.spyOn(registry, "updateSandbox");

    const receipt = await qualifyRebuildPolicyAuthority(
      { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
      {
        observeSandboxPresence: vi.fn(() => "present" as const),
        inspectSandboxPolicyAuthority: vi.fn(() => inspection),
        inspectGlobalPolicyAuthority: vi.fn(() => inspection),
      },
    );

    expect(receipt.authority).toBe("externally-managed");
    expect(receipt.requiredPolicies).toHaveLength(2);
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("retains only agreed legacy authority when an external requirement is missing (#9833)", async () => {
    const entry = sandboxEntry(undefined);
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: externalEffectivePolicy(false),
    };
    const updateSandbox = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);

    await expect(
      qualifyRebuildPolicyAuthority(
        { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
        {
          observeSandboxPresence: vi.fn(() => "present" as const),
          inspectSandboxPolicyAuthority: vi.fn(() => inspection),
          inspectGlobalPolicyAuthority: vi.fn(() => inspection),
        },
      ),
    ).rejects.toThrow(/missing entries "custom-api"/);
    expect(updateSandbox).toHaveBeenCalledWith("alpha", {
      policyAuthority: "externally-managed",
    });
    expect(entry).toEqual({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      policies: [],
      policyAuthority: "externally-managed",
    });
  });

  it("backfills legacy rebuild authority after live and global requirements match (#9833)", async () => {
    const entry = sandboxEntry(undefined);
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: externalEffectivePolicy(),
    };
    const updateSandbox = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);

    const receipt = await qualifyRebuildPolicyAuthority(
      { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
      {
        observeSandboxPresence: vi.fn(() => "present" as const),
        inspectSandboxPolicyAuthority: vi.fn(() => inspection),
        inspectGlobalPolicyAuthority: vi.fn(() => inspection),
      },
    );

    expect(updateSandbox).toHaveBeenCalledWith("alpha", {
      policyAuthority: "externally-managed",
    });
    expect(entry).toEqual({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      policies: [],
      policyAuthority: "externally-managed",
    });
    expect(receipt.authority).toBe("externally-managed");
  });

  it("uses recorded global authority when the rebuild source is absent (#9833)", async () => {
    const entry = sandboxEntry("externally-managed");
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: externalEffectivePolicy(),
    };
    const inspectSandbox = vi.fn();

    const receipt = await qualifyRebuildPolicyAuthority(
      { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
      {
        observeSandboxPresence: vi.fn(() => "missing" as const),
        inspectSandboxPolicyAuthority: inspectSandbox,
        inspectGlobalPolicyAuthority: vi.fn(() => inspection),
      },
    );

    expect(receipt.authority).toBe("externally-managed");
    expect(inspectSandbox).not.toHaveBeenCalled();
  });

  it("omits a validated MCP recovery preset while retaining its exact requirement (#9833)", async () => {
    const entry = sandboxEntry("nemoclaw-managed");
    const bridge = {
      server: "github",
      agent: "openclaw",
      adapter: "mcporter",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github",
      providerId: "provider-1",
      policyName: buildMcpBridgePolicyName("github"),
      addedAt: "2026-08-20T00:00:00.000Z",
    };
    entry.mcp = { bridges: { github: bridge } };
    const manifest = {
      ...makePreparedRecoveryManifest(),
      policyPresets: ["npm", bridge.policyName],
      customPolicies: entry.customPolicies,
    };
    const inspection = {
      authority: "nemoclaw-managed" as const,
      effectivePolicy: {},
    };

    const receipt = await qualifyRebuildPolicyAuthority(
      { sandboxName: "alpha", sandboxEntry: entry, manifest },
      {
        observeSandboxPresence: vi.fn(() => "present" as const),
        inspectSandboxPolicyAuthority: vi.fn(() => inspection),
        inspectGlobalPolicyAuthority: vi.fn(() => inspection),
      },
    );

    expect(receipt.requiredPolicies).toHaveLength(3);
    expect(receipt.requiredPolicies[0]).toMatchObject({
      network_policies: { npm_yarn: expect.any(Object) },
    });
    expect(receipt.managedMcpPolicies).toHaveLength(1);
    expect(receipt.requiredPolicies).toContainEqual(receipt.managedMcpPolicies[0]);
    expect(receipt.managedMcpPolicies[0]).toMatchObject({
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

  it("refuses an unknown non-MCP preset from a recovery manifest (#9833)", async () => {
    const entry = sandboxEntry("nemoclaw-managed");
    const inspectSandbox = vi.fn();
    const inspectGlobal = vi.fn();

    await expect(
      qualifyRebuildPolicyAuthority(
        {
          sandboxName: "alpha",
          sandboxEntry: entry,
          manifest: {
            ...makePreparedRecoveryManifest(),
            policyPresets: ["retired-custom-policy"],
          },
        },
        {
          observeSandboxPresence: vi.fn(() => "present" as const),
          inspectSandboxPolicyAuthority: inspectSandbox,
          inspectGlobalPolicyAuthority: inspectGlobal,
        },
      ),
    ).rejects.toThrow(
      "recorded policy preset \"retired-custom-policy\" is neither a current built-in policy preset for 'openclaw' nor a validated managed MCP policy",
    );
    expect(inspectSandbox).not.toHaveBeenCalled();
    expect(inspectGlobal).not.toHaveBeenCalled();
  });

  it("refuses an absent legacy source without recording current global authority (#9833)", async () => {
    const entry = sandboxEntry(undefined);
    const inspection = {
      authority: "nemoclaw-managed" as const,
      effectivePolicy: {},
    };
    const inspectSandbox = vi.fn();
    const updateSandbox = vi.spyOn(registry, "updateSandbox");

    await expect(
      qualifyRebuildPolicyAuthority(
        { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
        {
          observeSandboxPresence: vi.fn(() => "missing" as const),
          inspectSandboxPolicyAuthority: inspectSandbox,
          inspectGlobalPolicyAuthority: vi.fn(() => inspection),
        },
      ),
    ).rejects.toThrow(/sandbox is absent and its recorded policy authority is missing/);
    expect(inspectSandbox).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("rejects missing external requirements while the rebuild source is absent (#9833)", async () => {
    const entry = sandboxEntry("externally-managed");
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: externalEffectivePolicy(false),
    };
    const inspectSandbox = vi.fn();

    await expect(
      qualifyRebuildPolicyAuthority(
        { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
        {
          observeSandboxPresence: vi.fn(() => "missing" as const),
          inspectSandboxPolicyAuthority: inspectSandbox,
          inspectGlobalPolicyAuthority: vi.fn(() => inspection),
        },
      ),
    ).rejects.toThrow(/missing entries "custom-api"/);
    expect(inspectSandbox).not.toHaveBeenCalled();
  });
});
