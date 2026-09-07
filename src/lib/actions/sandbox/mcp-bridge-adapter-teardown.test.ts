// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  assertGeneratedPolicyRegistrationMutationSafe: vi.fn(),
  assertMcpDestroyNotPending: vi.fn(),
  bridgeState: vi.fn(),
  discardSafeIncompleteMcpAdds: vi.fn(),
  ensureSandboxGatewaySelected: vi.fn(),
  getMcpProviderInspectionRuntimeSelection: vi.fn(() => ({
    gatewayName: "nemoclaw-8091",
    workspace: "default",
  })),
  getBridgeAdapter: vi.fn(),
  getSandboxAgent: vi.fn(),
  captureRecordedSandboxBasePolicy: vi.fn(),
  getSandboxOrThrow: vi.fn(),
  inspectExactMcpDestroyProvider: vi.fn(),
  inspectMcpProvider: vi.fn(),
  observeMcpCredentialRevision: vi.fn(),
  preflightMcpEntryTargets: vi.fn(),
  removeGeneratedPolicy: vi.fn(),
  registerAgentAdapterAtCurrentCredentialRevision: vi.fn(),
  restoreExistingMcpBridgeRuntime: vi.fn(),
  setBridgeState: vi.fn(),
  unregisterAgentAdapter: vi.fn(),
}));

vi.mock("../../state/registry", () => ({
  getSandbox: vi.fn(),
  updateSandbox: vi.fn(),
}));

vi.mock("./mcp-bridge-adapters", () => ({
  registerAgentAdapterAtCurrentCredentialRevision:
    mocks.registerAgentAdapterAtCurrentCredentialRevision,
  unregisterAgentAdapter: mocks.unregisterAgentAdapter,
}));

vi.mock("./mcp-bridge-provider-readiness", () => ({
  observeMcpCredentialRevision: mocks.observeMcpCredentialRevision,
}));

vi.mock("./mcp-bridge-provider", () => ({
  assertMcpProviderRecoverable: vi.fn(),
  assertNoProviderCredentialCollisions: vi.fn(),
  assertNoRegisteredProviderCredentialCollisions: vi.fn(),
  detachProvider: vi.fn(),
  getMcpProviderInspectionRuntimeSelection: mocks.getMcpProviderInspectionRuntimeSelection,
  inspectMcpProvider: mocks.inspectMcpProvider,
  preflightMcpEntryTargets: mocks.preflightMcpEntryTargets,
  waitForDetachedMcpCredential: vi.fn(),
}));

vi.mock("./mcp-bridge-destroy-preflight", () => ({
  cloneMcpBridgeEntry: vi.fn((entry: McpBridgeEntry) => ({ ...entry, env: [...entry.env] })),
  discardSafeIncompleteMcpAdds: mocks.discardSafeIncompleteMcpAdds,
  inspectExactMcpDestroyProvider: mocks.inspectExactMcpDestroyProvider,
}));

vi.mock("./mcp-bridge-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-policy")>()),
  assertGeneratedPolicyMutationSafe: vi.fn(),
  assertGeneratedPolicyRegistrationMutationSafe:
    mocks.assertGeneratedPolicyRegistrationMutationSafe,
  buildMcpBridgePolicyKey: vi.fn(() => "mcp_bridge_github"),
  removeGeneratedPolicy: mocks.removeGeneratedPolicy,
}));

vi.mock("../../policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../policy")>()),
  captureRecordedSandboxBasePolicy: mocks.captureRecordedSandboxBasePolicy,
}));

vi.mock("./mcp-bridge-restart", () => ({
  restoreExistingMcpBridgeRuntime: mocks.restoreExistingMcpBridgeRuntime,
}));

vi.mock("./mcp-bridge-runtime-capabilities", () => ({
  assertMcpAdapterTeardownRuntimeCapabilities: vi.fn(),
}));

vi.mock("./mcp-bridge-state", () => ({
  assertMcpDestroyNotPending: mocks.assertMcpDestroyNotPending,
  bridgeState: mocks.bridgeState,
  ensureSandboxGatewaySelected: mocks.ensureSandboxGatewaySelected,
  getBridgeAdapter: mocks.getBridgeAdapter,
  getSandboxAgent: mocks.getSandboxAgent,
  getSandboxOrThrow: mocks.getSandboxOrThrow,
  nowIso: vi.fn(() => new Date(0).toISOString()),
  setBridgeState: mocks.setBridgeState,
}));

vi.mock("./mcp-bridge-validation", () => ({
  assertAuthenticatedBridgeEntry: vi.fn(),
  validateSandboxName: vi.fn(),
}));

import { prepareMcpBridgesForDestroy } from "./mcp-bridge-destroy";
import {
  prepareMcpBridgesForAbsentSandboxRebuild,
  prepareMcpBridgesForExecUnavailableRebuild,
  prepareMcpBridgesForRebuild,
  restoreMcpBridgesAfterRebuild,
} from "./mcp-bridge-rebuild";
import { scrubManagedMcpAdapterOrThrow } from "./mcp-bridge-adapter-teardown";

const sandbox = { agent: "hermes" } as SandboxEntry;
const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" } as const;
const entry: McpBridgeEntry = {
  server: "github",
  agent: "hermes",
  adapter: "hermes-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  allowedIps: ["8.8.8.8"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

describe("MCP adapter teardown rollback", () => {
  beforeEach(() => {
    mocks.assertGeneratedPolicyRegistrationMutationSafe.mockReset().mockReturnValue({
      content: "version: 1\nnetwork_policies:\n  mcp_bridge_github: {}\n",
    });
    mocks.bridgeState.mockReset().mockReturnValue({ github: entry });
    mocks.discardSafeIncompleteMcpAdds.mockReset().mockResolvedValue(sandbox);
    mocks.ensureSandboxGatewaySelected.mockReset().mockResolvedValue(undefined);
    mocks.getMcpProviderInspectionRuntimeSelection.mockReset().mockReturnValue(runtimeSelection);
    mocks.getBridgeAdapter.mockReset().mockReturnValue("hermes-config");
    mocks.getSandboxAgent.mockReset().mockReturnValue("hermes");
    mocks.captureRecordedSandboxBasePolicy
      .mockReset()
      .mockReturnValue("version: 1\nnetwork_policies:\n  mcp_bridge_github: {}\n");
    mocks.getSandboxOrThrow.mockReset().mockReturnValue(sandbox);
    mocks.inspectExactMcpDestroyProvider.mockReset().mockReturnValue({
      credentialKeys: ["GITHUB_TOKEN"],
      exists: true,
      id: entry.providerId,
      resourceVersion: 12,
      type: "nemoclaw-mcp-v1",
    });
    mocks.inspectMcpProvider.mockReset().mockReturnValue({ exists: false });
    mocks.observeMcpCredentialRevision.mockReset().mockReturnValue("v12");
    mocks.preflightMcpEntryTargets
      .mockReset()
      .mockResolvedValue(new Map([[entry.server, { addresses: ["8.8.8.8"] }]]));
    mocks.removeGeneratedPolicy.mockReset().mockImplementation(() => {
      throw new Error("forced lifecycle failure after adapter scrub");
    });
    mocks.registerAgentAdapterAtCurrentCredentialRevision.mockReset();
    mocks.restoreExistingMcpBridgeRuntime.mockReset();
    mocks.setBridgeState.mockReset();
    mocks.unregisterAgentAdapter.mockReset().mockReturnValue("removed");
  });

  it.each([
    ["rebuild", prepareMcpBridgesForRebuild],
    ["destroy", prepareMcpBridgesForDestroy],
  ] as const)(
    "restores the fresh revision observed after a later %s step fails (#10155)",
    async (_lifecycle, prepare) => {
      mocks.observeMcpCredentialRevision
        .mockReset()
        .mockReturnValueOnce("v12")
        .mockReturnValueOnce("v13")
        .mockReturnValue("v13");

      await expect(prepare("alpha")).rejects.toThrow(
        "forced lifecycle failure after adapter scrub",
      );
      expect(mocks.unregisterAgentAdapter).toHaveBeenCalledOnce();
      expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).toHaveBeenCalledWith(
        "alpha",
        "hermes-config",
        expect.objectContaining({ ...entry, credentialRevision: "v12" }),
        runtimeSelection,
        {},
        "v13",
        {
          replaceExisting: true,
          teardownRollback: true,
        },
      );
      expect(mocks.restoreExistingMcpBridgeRuntime).not.toHaveBeenCalled();
    },
  );

  it("does not derive a Hermes credential revision from an exact provider resource version", () => {
    mocks.observeMcpCredentialRevision.mockReturnValue("absent");
    mocks.inspectMcpProvider.mockReturnValue({
      credentialKeys: ["GITHUB_TOKEN"],
      exists: true,
      id: entry.providerId,
      resourceVersion: 12,
      type: "nemoclaw-mcp-v1",
    });

    expect(() => scrubManagedMcpAdapterOrThrow("alpha", sandbox, entry, runtimeSelection)).toThrow(
      "Could not prove a revision-scoped credential before removing the managed adapter entry for MCP server 'github'.",
    );
    expect(mocks.inspectMcpProvider).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).not.toHaveBeenCalled();
  });

  it("recovers the recorded gateway before initial destroy provider inspection (#10514)", async () => {
    const events: string[] = [];
    mocks.ensureSandboxGatewaySelected.mockImplementation(async () => {
      events.push("gateway-selected");
    });
    mocks.inspectExactMcpDestroyProvider.mockImplementation(() => {
      events.push("provider-inspected");
      return {
        credentialKeys: ["GITHUB_TOKEN"],
        exists: true,
        id: entry.providerId,
        resourceVersion: 12,
        type: "nemoclaw-mcp-v1",
      };
    });

    await expect(prepareMcpBridgesForDestroy("alpha")).rejects.toThrow(
      "forced lifecycle failure after adapter scrub",
    );
    expect(events.slice(0, 2)).toEqual(["gateway-selected", "provider-inspected"]);
  });

  it.each([
    ["live", prepareMcpBridgesForRebuild],
    ["absent", prepareMcpBridgesForAbsentSandboxRebuild],
  ] as const)(
    "drops a prepared-only manifest before resolving runtime authority for %s rebuild (#10514)",
    async (_kind, prepare) => {
      const preparedEntry = { ...entry, addState: "prepared" as const };
      const preparedSandbox = {
        name: "alpha",
        agent: "hermes",
        mcp: { bridges: { github: preparedEntry } },
      } as SandboxEntry;
      const clearedSandbox = { name: "alpha", agent: "hermes" } as SandboxEntry;
      mocks.getSandboxOrThrow.mockReturnValue(preparedSandbox);
      mocks.bridgeState.mockImplementation(
        (candidate: SandboxEntry) => candidate.mcp?.bridges ?? {},
      );
      mocks.discardSafeIncompleteMcpAdds.mockResolvedValue(clearedSandbox);
      mocks.getMcpProviderInspectionRuntimeSelection.mockImplementation(() => {
        throw new Error("runtime selection resolved for a prepared-only rebuild");
      });

      await expect(prepare("alpha")).resolves.toMatchObject({
        entries: [],
        detachedProviderEntries: [],
        scrubbedAdapterEntries: [],
      });

      expect(mocks.getMcpProviderInspectionRuntimeSelection).not.toHaveBeenCalled();
      expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
    },
  );

  it("keeps empty exec-unavailable rebuild preparation independent of runtime authority (#10514)", async () => {
    const emptySandbox = {
      name: "alpha",
      agent: "hermes",
      gatewayName: "nemoclaw",
    } as SandboxEntry;
    mocks.getSandboxOrThrow.mockReturnValue(emptySandbox);
    mocks.getSandboxAgent.mockReturnValue({ name: "hermes" });
    mocks.bridgeState.mockReturnValue({});
    mocks.getMcpProviderInspectionRuntimeSelection.mockImplementation(() => {
      throw new Error("runtime selection resolved for empty rebuild state");
    });

    await expect(prepareMcpBridgesForExecUnavailableRebuild("alpha")).resolves.toMatchObject({
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
    });

    expect(mocks.getMcpProviderInspectionRuntimeSelection).not.toHaveBeenCalled();
    expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an interrupted denied-tool update",
      { ...entry, pendingDenyTools: ["replacement_*"] },
      /interrupted denied-tool update.*mcp restart github/,
    ],
    [
      "a legacy public entry without pins",
      { ...entry, allowedIps: undefined },
      /legacy public registration without recorded address pins.*mcp restart github/,
    ],
  ] as const)("rejects exec-unavailable rebuild for %s (#11115)", async (_case, candidate, error) => {
    mocks.bridgeState.mockReturnValue({ github: candidate });
    mocks.getSandboxAgent.mockReturnValue({ name: "hermes" });
    mocks.getBridgeAdapter.mockReturnValue("hermes-config");

    await expect(prepareMcpBridgesForExecUnavailableRebuild("alpha")).rejects.toThrow(error);

    expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
    expect(mocks.preflightMcpEntryTargets).not.toHaveBeenCalled();
  });

  const expectLegacyPublicPinsPersisted = async (
    prepare: (sandboxName: string) => Promise<{ entries: McpBridgeEntry[] }>,
  ) => {
    const legacyEntry = { ...entry, allowedIps: undefined };
    mocks.bridgeState.mockReturnValue({ github: legacyEntry });
    mocks.preflightMcpEntryTargets.mockResolvedValue(
      new Map([[entry.server, { addresses: ["9.9.9.9"] }]]),
    );

    const preparation = await prepare("alpha");

    expect(preparation.entries).toEqual([
      expect.objectContaining({ allowedIps: ["9.9.9.9"], updatedAt: new Date(0).toISOString() }),
    ]);
    expect(mocks.setBridgeState).toHaveBeenCalledWith("alpha", {
      github: expect.objectContaining({ allowedIps: ["9.9.9.9"] }),
    });
    expect(mocks.assertGeneratedPolicyRegistrationMutationSafe).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ allowedIps: ["9.9.9.9"] }),
    );
  };

  it("persists validated pins for a legacy public entry during live rebuild preparation (#11115)", async () => {
    mocks.removeGeneratedPolicy.mockReset();
    mocks.captureRecordedSandboxBasePolicy
      .mockReset()
      .mockReturnValueOnce("version: 1\nnetwork_policies:\n  mcp_bridge_github: {}\n")
      .mockReturnValueOnce("version: 1\nnetwork_policies: {}\n");

    await expectLegacyPublicPinsPersisted(prepareMcpBridgesForRebuild);
  });

  it("persists validated pins for a legacy public entry during absent rebuild preparation (#11115)", async () => {
    await expectLegacyPublicPinsPersisted(prepareMcpBridgesForAbsentSandboxRebuild);
  });

  it("materializes an interrupted denied-tool update during rebuild preparation (#11115)", async () => {
    mocks.bridgeState.mockReturnValue({
      github: {
        ...entry,
        denyTools: ["old_tool"],
        pendingDenyTools: ["replacement_*"],
      },
    });

    const preparation = await prepareMcpBridgesForAbsentSandboxRebuild("alpha");

    expect(preparation.entries).toEqual([
      expect.objectContaining({ denyTools: ["replacement_*"] }),
    ]);
    expect(preparation.entries[0]).not.toHaveProperty("pendingDenyTools");
    expect(mocks.setBridgeState).toHaveBeenCalledWith("alpha", {
      github: expect.objectContaining({ denyTools: ["replacement_*"] }),
    });
  });

  it("commits journaled denied tools only after post-rebuild runtime restoration (#11115)", async () => {
    const pendingEntry = {
      ...entry,
      denyTools: ["old_tool"],
      pendingDenyTools: ["replacement_*"],
    };

    await restoreMcpBridgesAfterRebuild("alpha", [pendingEntry], runtimeSelection);

    expect(mocks.setBridgeState).toHaveBeenNthCalledWith(1, "alpha", {
      github: expect.objectContaining({ pendingDenyTools: ["replacement_*"] }),
    });
    expect(mocks.restoreExistingMcpBridgeRuntime).toHaveBeenCalledWith(
      "alpha",
      [expect.objectContaining({ denyTools: ["replacement_*"] })],
      expect.objectContaining({ applyPolicy: false }),
    );
    expect(mocks.setBridgeState).toHaveBeenLastCalledWith("alpha", {
      github: expect.not.objectContaining({ pendingDenyTools: expect.anything() }),
    });
  });

  it("retains journaled denied tools when post-rebuild runtime restoration fails (#11115)", async () => {
    mocks.restoreExistingMcpBridgeRuntime.mockRejectedValueOnce(new Error("restore failed"));
    const pendingEntry = {
      ...entry,
      denyTools: ["old_tool"],
      pendingDenyTools: ["replacement_*"],
    };

    await expect(
      restoreMcpBridgesAfterRebuild("alpha", [pendingEntry], runtimeSelection),
    ).rejects.toThrow("restore failed");

    expect(mocks.setBridgeState).toHaveBeenCalledOnce();
    expect(mocks.setBridgeState).toHaveBeenCalledWith("alpha", {
      github: expect.objectContaining({ pendingDenyTools: ["replacement_*"] }),
    });
  });

  it("rejects rebuild when live policy differs from persisted denied-tool intent (#11115)", async () => {
    mocks.assertGeneratedPolicyRegistrationMutationSafe.mockReturnValue({
      content:
        "version: 1\nnetwork_policies:\n  mcp_bridge_github:\n    endpoints:\n      - deny_rules:\n          - method: tools/call\n            tool: delete_*\n",
    });

    await expect(prepareMcpBridgesForRebuild("alpha")).rejects.toThrow(
      /generated policy does not match.*mcp restart github/,
    );
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
  });
});
