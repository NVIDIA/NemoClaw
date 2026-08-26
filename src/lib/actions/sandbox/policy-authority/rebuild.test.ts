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
import { buildMcpBridgePolicyName, buildMcpBridgePolicyYaml } from "../mcp-bridge-policy";
import type { RebuildSandboxEntry } from "../rebuild-flow-helpers";
import { makePreparedRecoveryManifest } from "../rebuild-flow-test-fixtures";
import { qualifyRebuildPolicyAuthority } from "./rebuild";

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
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    };
    const updateSandbox = vi.spyOn(registry, "updateSandbox");

    const receipt = await qualifyRebuildPolicyAuthority(
      { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
      {
        observeSandboxPresence: vi.fn(() => "present" as const),
        inspectSandboxPolicyAuthority: vi.fn(() => inspection),
        inspectActiveGlobalPolicy: vi.fn(() => ({ state: "active" as const, inspection })),
      },
    );

    expect(receipt.authority).toBe("externally-managed");
    expect(receipt.requiredPolicies).toHaveLength(2);
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("verifies a durably external sandbox policy whose live owner is unknown (#9833)", async () => {
    const recorded = {
      ...sandboxEntry("externally-managed"),
      gatewayPort: 8080,
      lifecycleGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      lifecycleLiveIdentityFingerprint: "sandbox-identity",
    } as RebuildSandboxEntry;
    const inputEntry = { ...recorded };
    const sandboxInspection = {
      authority: "owner-unknown" as const,
      effectivePolicy: externalEffectivePolicy(),
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    };
    const globalInspection = {
      ...sandboxInspection,
      authority: "externally-managed" as const,
    };
    vi.spyOn(registry, "getSandbox").mockReturnValue(recorded as never);

    const receipt = await qualifyRebuildPolicyAuthority(
      { sandboxName: "alpha", sandboxEntry: inputEntry, manifest: null },
      {
        observeSandboxPresence: vi.fn(() => "present" as const),
        assertOpenShellGatewayPortBinding: vi.fn(),
        inspectOpenShellSandboxIdentityFingerprint: vi.fn(() => "sandbox-identity"),
        inspectSandboxPolicyAuthority: vi.fn(() => sandboxInspection),
        inspectActiveGlobalPolicy: vi.fn(() => ({
          state: "active" as const,
          inspection: globalInspection,
        })),
      },
    );

    expect(receipt.authority).toBe("externally-managed");
    expect(receipt.requiredPolicies).toHaveLength(2);
  });

  it("rejects a missing requirement from a durably external owner-unknown policy (#9833)", async () => {
    const recorded = {
      ...sandboxEntry("externally-managed"),
      gatewayPort: 8080,
      lifecycleGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      lifecycleLiveIdentityFingerprint: "sandbox-identity",
    } as RebuildSandboxEntry;
    const sandboxInspection = {
      authority: "owner-unknown" as const,
      effectivePolicy: externalEffectivePolicy(false),
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    };
    const globalInspection = {
      authority: "externally-managed" as const,
      effectivePolicy: externalEffectivePolicy(),
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    };
    vi.spyOn(registry, "getSandbox").mockReturnValue(recorded as never);

    await expect(
      qualifyRebuildPolicyAuthority(
        { sandboxName: "alpha", sandboxEntry: { ...recorded }, manifest: null },
        {
          observeSandboxPresence: vi.fn(() => "present" as const),
          assertOpenShellGatewayPortBinding: vi.fn(),
          inspectOpenShellSandboxIdentityFingerprint: vi.fn(() => "sandbox-identity"),
          inspectSandboxPolicyAuthority: vi.fn(() => sandboxInspection),
          inspectActiveGlobalPolicy: vi.fn(() => ({
            state: "active" as const,
            inspection: globalInspection,
          })),
        },
      ),
    ).rejects.toThrow(/missing entries "custom-api"/);
  });

  it.each([
    ["an empty mapping", "{}\n"],
    ["a diagnostic mapping", "diagnostic: failed\n"],
    ["a non-positive version", "version: 0\nnetwork_policies: {}\n"],
    ["a non-mapping network policy set", "version: 1\nnetwork_policies: []\n"],
  ])("rejects %s as a required custom policy document (#9833)", async (_label, content) => {
    const entry = sandboxEntry("externally-managed");
    entry.customPolicies = [{ name: "invalid", content, sourcePath: "/tmp/invalid-policy" }];
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: externalEffectivePolicy(),
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    };

    await expect(
      qualifyRebuildPolicyAuthority(
        { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
        {
          observeSandboxPresence: vi.fn(() => "present" as const),
          inspectSandboxPolicyAuthority: vi.fn(() => inspection),
          inspectActiveGlobalPolicy: vi.fn(() => ({ state: "active" as const, inspection })),
        },
      ),
    ).rejects.toThrow("a required network policy document is invalid");
  });

  it("retains only agreed legacy authority when an external requirement is missing (#9833)", async () => {
    const entry = sandboxEntry(undefined);
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: externalEffectivePolicy(false),
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    };
    const updateSandbox = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);

    await expect(
      qualifyRebuildPolicyAuthority(
        { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
        {
          observeSandboxPresence: vi.fn(() => "present" as const),
          inspectSandboxPolicyAuthority: vi.fn(() => inspection),
          inspectActiveGlobalPolicy: vi.fn(() => ({ state: "active" as const, inspection })),
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
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    };
    const updateSandbox = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);

    const receipt = await qualifyRebuildPolicyAuthority(
      { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
      {
        observeSandboxPresence: vi.fn(() => "present" as const),
        inspectSandboxPolicyAuthority: vi.fn(() => inspection),
        inspectActiveGlobalPolicy: vi.fn(() => ({ state: "active" as const, inspection })),
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
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    };
    const inspectSandbox = vi.fn();

    const receipt = await qualifyRebuildPolicyAuthority(
      { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
      {
        observeSandboxPresence: vi.fn(() => "missing" as const),
        inspectSandboxPolicyAuthority: inspectSandbox,
        inspectActiveGlobalPolicy: vi.fn(() => ({ state: "active" as const, inspection })),
      },
    );

    expect(receipt.authority).toBe("externally-managed");
    expect(inspectSandbox).not.toHaveBeenCalled();
  });

  it("omits a validated MCP recovery preset while retaining its exact requirement (#9833)", async () => {
    const entry = sandboxEntry("externally-managed");
    const bridge = {
      server: "github",
      agent: "openclaw",
      adapter: "mcporter" as const,
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
    const baseline = policies.resolveAgentBaselinePolicy("openclaw")!;
    const effectivePolicy = YAML.parse(
      policies.mergePresetNamesIntoPolicy(baseline.content, ["npm"], {
        agent: "openclaw",
      }).policy,
    ) as {
      network_policies: Record<string, unknown>;
    };
    const customPolicy = YAML.parse(CUSTOM_POLICY) as {
      network_policies: Record<string, unknown>;
    };
    const mcpPolicy = YAML.parse(
      buildMcpBridgePolicyYaml(
        bridge.server,
        bridge.url,
        bridge.adapter,
        { addresses: ["8.8.8.8"] },
        bridge.providerName,
      ),
    ) as { network_policies: Record<string, unknown> };
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: {
        ...effectivePolicy,
        network_policies: {
          ...effectivePolicy.network_policies,
          ...customPolicy.network_policies,
          ...mcpPolicy.network_policies,
        },
      },
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    };

    const receipt = await qualifyRebuildPolicyAuthority(
      { sandboxName: "alpha", sandboxEntry: entry, manifest },
      {
        observeSandboxPresence: vi.fn(() => "present" as const),
        inspectSandboxPolicyAuthority: vi.fn(() => inspection),
        inspectActiveGlobalPolicy: vi.fn(() => ({ state: "active" as const, inspection })),
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
    const entry = sandboxEntry("externally-managed");
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: externalEffectivePolicy(),
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    };
    const inspectSandbox = vi.fn(() => inspection);
    const inspectGlobal = vi.fn(() => ({ state: "active" as const, inspection }));

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
          inspectActiveGlobalPolicy: inspectGlobal,
        },
      ),
    ).rejects.toThrow(
      "recorded policy preset \"retired-custom-policy\" is neither a current built-in policy preset for 'openclaw' nor a validated managed MCP policy",
    );
    expect(inspectSandbox).toHaveBeenCalledOnce();
    expect(inspectGlobal).toHaveBeenCalledOnce();
  });

  it("refuses malformed recorded preset metadata (#9833)", async () => {
    const entry = sandboxEntry("externally-managed");
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: externalEffectivePolicy(),
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    };

    await expect(
      qualifyRebuildPolicyAuthority(
        {
          sandboxName: "alpha",
          sandboxEntry: entry,
          manifest: {
            ...makePreparedRecoveryManifest(),
            policyPresets: [null] as never,
          },
        },
        {
          observeSandboxPresence: vi.fn(() => "present" as const),
          inspectSandboxPolicyAuthority: vi.fn(() => inspection),
          inspectActiveGlobalPolicy: vi.fn(() => ({ state: "active" as const, inspection })),
        },
      ),
    ).rejects.toThrow("recorded policy preset metadata is invalid");
  });

  it("refuses malformed custom policy metadata before reading its source (#9833)", async () => {
    const entry = sandboxEntry("externally-managed");
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: externalEffectivePolicy(),
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    };

    await expect(
      qualifyRebuildPolicyAuthority(
        {
          sandboxName: "alpha",
          sandboxEntry: entry,
          manifest: {
            ...makePreparedRecoveryManifest(),
            customPolicies: [null] as never,
          },
        },
        {
          observeSandboxPresence: vi.fn(() => "present" as const),
          inspectSandboxPolicyAuthority: vi.fn(() => inspection),
          inspectActiveGlobalPolicy: vi.fn(() => ({ state: "active" as const, inspection })),
        },
      ),
    ).rejects.toThrow("required custom policy metadata is invalid");
  });

  it("refuses an absent legacy source without recording current global authority (#9833)", async () => {
    const entry = sandboxEntry(undefined);
    const inspectSandbox = vi.fn();
    const updateSandbox = vi.spyOn(registry, "updateSandbox");

    await expect(
      qualifyRebuildPolicyAuthority(
        { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
        {
          observeSandboxPresence: vi.fn(() => "missing" as const),
          inspectSandboxPolicyAuthority: inspectSandbox,
          inspectActiveGlobalPolicy: vi.fn(() => ({ state: "absent" as const })),
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
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    };
    const inspectSandbox = vi.fn();

    await expect(
      qualifyRebuildPolicyAuthority(
        { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
        {
          observeSandboxPresence: vi.fn(() => "missing" as const),
          inspectSandboxPolicyAuthority: inspectSandbox,
          inspectActiveGlobalPolicy: vi.fn(() => ({ state: "active" as const, inspection })),
        },
      ),
    ).rejects.toThrow(/missing entries "custom-api"/);
    expect(inspectSandbox).not.toHaveBeenCalled();
  });
});
