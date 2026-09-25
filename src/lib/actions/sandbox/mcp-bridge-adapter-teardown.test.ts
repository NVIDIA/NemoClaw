// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import type { McpSourceEntry } from "./mcp-bridge-contracts";

const mocks = vi.hoisted(() => ({
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
  assertMcpProviderRecoverable: vi.fn(),
  assertMcpAdapterTeardownRuntimeCapabilities: vi.fn(),
  preflightMcpEntryTargets: vi.fn(),
  detachProvider: vi.fn(),
  observeMcpCredentialRevision: vi.fn(),
  removeGeneratedPolicy: vi.fn(),
  registerAgentAdapterAtCurrentCredentialRevision: vi.fn(),
  restoreExistingMcpBridgeRuntime: vi.fn(),
  unregisterAgentAdapter: vi.fn(),
}));

vi.mock("../../state/registry", () => ({ getSandbox: vi.fn(), updateSandbox: vi.fn() }));
vi.mock("./mcp-bridge-adapters", () => ({
  registerAgentAdapterAtCurrentCredentialRevision:
    mocks.registerAgentAdapterAtCurrentCredentialRevision,
  unregisterAgentAdapter: mocks.unregisterAgentAdapter,
}));
vi.mock("./mcp-bridge-provider-readiness", () => ({
  observeMcpCredentialRevision: mocks.observeMcpCredentialRevision,
}));
vi.mock("./mcp-bridge-provider", () => ({
  assertMcpProviderRecoverable: mocks.assertMcpProviderRecoverable,
  assertNoProviderCredentialCollisions: vi.fn(),
  assertNoRegisteredProviderCredentialCollisions: vi.fn(),
  detachProvider: mocks.detachProvider,
  getMcpProviderInspectionRuntimeSelection: mocks.getMcpProviderInspectionRuntimeSelection,
  inspectMcpProvider: mocks.inspectMcpProvider,
  preflightMcpEntryTargets: mocks.preflightMcpEntryTargets,
  waitForDetachedMcpCredential: vi.fn(),
}));
vi.mock("./mcp-bridge-destroy-preflight", () => ({
  cloneMcpSourceEntry: vi.fn((candidate: McpSourceEntry) => ({
    ...candidate,
    env: [...candidate.env],
  })),
  inspectExactMcpDestroyProvider: mocks.inspectExactMcpDestroyProvider,
}));
vi.mock("./mcp-bridge-policy", () => ({
  assertGeneratedPolicyMutationSafe: vi.fn(),
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
  assertMcpAdapterTeardownRuntimeCapabilities: mocks.assertMcpAdapterTeardownRuntimeCapabilities,
}));
vi.mock("./mcp-bridge-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-state")>()),
  ensureSandboxGatewaySelected: mocks.ensureSandboxGatewaySelected,
  getBridgeAdapter: mocks.getBridgeAdapter,
  getSandboxAgent: mocks.getSandboxAgent,
  getSandboxOrThrow: mocks.getSandboxOrThrow,
}));
vi.mock("./mcp-bridge-validation", () => ({
  assertAuthenticatedBridgeEntry: vi.fn(),
  validateSandboxName: vi.fn(),
}));

import { scrubManagedMcpAdapterOrThrow } from "./mcp-bridge-adapter-teardown";
import {
  prepareMcpBridgesForAbsentSandboxRebuild,
  prepareMcpBridgesForStoppedSandboxRebuild,
  prepareMcpBridgesForRebuild,
  restoreMcpBridgesAfterRebuild,
} from "./mcp-bridge-rebuild";

const sandbox = { agent: "hermes" } as SandboxEntry;
const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" } as const;
const entry: McpSourceEntry = {
  server: "github",
  agent: "hermes",
  adapter: "hermes-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
};

describe("MCP adapter teardown rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureSandboxGatewaySelected.mockReset().mockResolvedValue(undefined);
    mocks.getMcpProviderInspectionRuntimeSelection.mockReset().mockReturnValue(runtimeSelection);
    mocks.getBridgeAdapter.mockReset().mockReturnValue("hermes-config");
    mocks.getSandboxAgent.mockReset().mockReturnValue("hermes");
    mocks.captureRecordedSandboxBasePolicy
      .mockReset()
      .mockResolvedValue("version: 1\nnetwork_policies:\n  mcp_bridge_github: {}\n");
    mocks.getSandboxOrThrow.mockReset().mockReturnValue(sandbox);
    mocks.inspectExactMcpDestroyProvider.mockReset().mockReturnValue({
      credentialKeys: ["GITHUB_TOKEN"],
      exists: true,
      id: entry.providerId,
      resourceVersion: 12,
      type: "nemoclaw-mcp-v1",
    });
    mocks.inspectMcpProvider.mockReset().mockReturnValue({ exists: false });
    mocks.assertMcpAdapterTeardownRuntimeCapabilities.mockReset().mockResolvedValue(undefined);
    mocks.observeMcpCredentialRevision.mockReset().mockResolvedValue("v12");
    mocks.removeGeneratedPolicy.mockReset().mockImplementation(async () => {
      throw new Error("forced lifecycle failure after adapter scrub");
    });
    mocks.registerAgentAdapterAtCurrentCredentialRevision.mockReset().mockResolvedValue("v12");
    mocks.restoreExistingMcpBridgeRuntime.mockReset();
    mocks.unregisterAgentAdapter.mockReset().mockReturnValue("removed");
  });

  it.each([
    ["present sandbox", prepareMcpBridgesForRebuild],
    ["absent sandbox", prepareMcpBridgesForAbsentSandboxRebuild],
  ] as const)(
    "rejects conflicting credentials before rebuild preparation with %s",
    async (_name, prepare) => {
      const conflicting = {
        ...entry,
        server: "github-alias",
        env: ["GITHUB_ALIAS_TOKEN"],
        providerName: "alpha-mcp-github-alias",
      };

      await expect(prepare("alpha", [entry, conflicting])).rejects.toThrow(
        /cannot safely choose between credentials for an indistinguishable endpoint/,
      );

      expect(mocks.preflightMcpEntryTargets).not.toHaveBeenCalled();
      expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
      expect(mocks.assertMcpProviderRecoverable).not.toHaveBeenCalled();
      expect(mocks.inspectMcpProvider).not.toHaveBeenCalled();
      expect(mocks.inspectExactMcpDestroyProvider).not.toHaveBeenCalled();
      expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
      expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
      expect(mocks.detachProvider).not.toHaveBeenCalled();
    },
  );

  it("preserves captured OpenClaw MCP intent without executing in or detaching the stopped source", async () => {
    mocks.getSandboxOrThrow.mockReturnValue({ name: "alpha", agent: "openclaw" });
    const source = { sandboxName: "alpha", directory: "/private/captured", assertCurrent: vi.fn() };
    const nativeEntry = { ...entry, agent: "openclaw", adapter: "openclaw-config" as const };
    const result = await prepareMcpBridgesForStoppedSandboxRebuild(
      "alpha",
      [nativeEntry],
      source,
      runtimeSelection,
    );
    expect(result.entries).toEqual([nativeEntry]);
    expect(result.detachedProviderEntries).toEqual([]);
    expect(mocks.assertMcpProviderRecoverable).toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    expect(source.assertCurrent).toHaveBeenCalledTimes(2);
    await expect(result.revalidateBeforeDelete?.()).resolves.toBeUndefined();
    mocks.captureRecordedSandboxBasePolicy.mockResolvedValue(
      "version: 1\nnetwork_policies:\n  changed: {}\n",
    );
    await expect(result.revalidateBeforeDelete?.()).rejects.toThrow("policy changed");
    await expect(
      prepareMcpBridgesForStoppedSandboxRebuild("beta", [nativeEntry], source, runtimeSelection),
    ).rejects.toThrow("does not match");
  });

  it("preserves distinct credential endpoints in an absent-sandbox rebuild handoff", async () => {
    const distinct = {
      ...entry,
      server: "other",
      url: "https://other.example.test/mcp/",
      env: ["OTHER_TOKEN"],
      providerName: "alpha-mcp-other",
    };

    await expect(
      prepareMcpBridgesForAbsentSandboxRebuild("alpha", [entry, distinct]),
    ).resolves.toMatchObject({
      entries: [entry, distinct],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
    });
    expect(mocks.preflightMcpEntryTargets).toHaveBeenCalledWith([entry, distinct]);
    expect(mocks.assertMcpProviderRecoverable).toHaveBeenCalledTimes(2);
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("restores the fresh revision observed after a later rebuild step fails (#10155)", async () => {
    mocks.observeMcpCredentialRevision
      .mockReset()
      .mockResolvedValueOnce("v12")
      .mockResolvedValueOnce("v13")
      .mockResolvedValue("v13");

    await expect(prepareMcpBridgesForRebuild("alpha", [entry])).rejects.toThrow(
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
      { replaceExisting: true, teardownRollback: true },
    );
    expect(mocks.restoreExistingMcpBridgeRuntime).not.toHaveBeenCalled();
  });

  it("preserves an existing Hermes entry through legacy teardown and replacement restore", async () => {
    mocks.captureRecordedSandboxBasePolicy
      .mockReset()
      .mockResolvedValueOnce("version: 1\nnetwork_policies:\n  mcp_bridge_github: {}\n")
      .mockResolvedValueOnce("version: 1\nnetwork_policies: {}\n");
    mocks.removeGeneratedPolicy.mockReset().mockResolvedValue(undefined);
    mocks.detachProvider.mockReset().mockResolvedValue("detached");
    mocks.restoreExistingMcpBridgeRuntime.mockReset().mockResolvedValue(undefined);

    const preparation = await prepareMcpBridgesForRebuild("alpha", [entry]);

    expect(mocks.assertMcpAdapterTeardownRuntimeCapabilities).toHaveBeenCalledWith(
      "alpha",
      sandbox,
      [entry],
      runtimeSelection,
    );
    expect(mocks.unregisterAgentAdapter).toHaveBeenCalledOnce();
    expect(mocks.removeGeneratedPolicy).toHaveBeenCalledOnce();
    expect(mocks.detachProvider).toHaveBeenCalledOnce();
    expect(preparation).toMatchObject({
      entries: [entry],
      detachedProviderEntries: [entry],
      scrubbedAdapterEntries: [expect.objectContaining(entry)],
      policyHandoff: "version: 1\nnetwork_policies:\n  mcp_bridge_github: {}\n",
      runtimeSelection,
    });

    await restoreMcpBridgesAfterRebuild("alpha", preparation.entries, runtimeSelection);

    expect(mocks.restoreExistingMcpBridgeRuntime).toHaveBeenCalledWith("alpha", [entry], {
      applyPolicy: false,
      runtimeSelection,
    });
  });

  it("does not derive a Hermes credential revision from an exact provider resource version", async () => {
    mocks.observeMcpCredentialRevision.mockResolvedValue("absent");
    mocks.inspectMcpProvider.mockReturnValue({
      credentialKeys: ["GITHUB_TOKEN"],
      exists: true,
      id: entry.providerId,
      resourceVersion: 12,
      type: "nemoclaw-mcp-v1",
    });

    await expect(
      scrubManagedMcpAdapterOrThrow("alpha", sandbox, entry, runtimeSelection),
    ).rejects.toThrow(
      "Could not prove a generation-scoped credential before removing the managed adapter entry for MCP server 'github'.",
    );
    expect(mocks.inspectMcpProvider).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).not.toHaveBeenCalled();
  });
});
