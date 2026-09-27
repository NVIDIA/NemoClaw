// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpProviderInspection } from "./mcp-bridge-provider";

const entry = {
  server: "github",
  agent: "openclaw",
  adapter: "openclaw-config" as const,
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId: "provider-id",
  policyName: "mcp-bridge-github",
  source: "legacy" as const,
};

const mocks = vi.hoisted(() => ({
  assertProviderRecoverable: vi.fn(),
  getSandbox: vi.fn(),
  getPolicyPresence: vi.fn(async () => true),
  getPolicyState: vi.fn(async () => "match"),
  getAgent: vi.fn(),
  getAdapter: vi.fn(),
  updateSandbox: vi.fn(),
  inspectLegacy: vi.fn(),
  inspectSource: vi.fn(),
  inspectPolicyOnly: vi.fn(),
  inspectSources: vi.fn(),
  joinEntries: vi.fn((_sandbox: unknown, entries: unknown) => entries),
  removeLegacy: vi.fn(),
  register: vi.fn(),
  reloadOpenClaw: vi.fn(),
  unregister: vi.fn(),
  selectGateway: vi.fn(),
  assertTeardown: vi.fn(),
  removePolicy: vi.fn(),
  inspectProvider: vi.fn(async (): Promise<McpProviderInspection> => ({
    exists: false,
    id: null,
    resourceVersion: null,
    type: null,
    credentialKeys: null,
  })),
  detachProvider: vi.fn(),
  waitForDetached: vi.fn(),
  preflightTargets: vi.fn().mockResolvedValue(new Map([["github", { addresses: ["8.8.8.8"] }]])),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withMcpLifecycleLock: async (_name: string, operation: () => Promise<unknown>) => operation(),
}));
vi.mock("../../state/registry", () => ({
  getSandbox: mocks.getSandbox,
  updateSandbox: mocks.updateSandbox,
}));
vi.mock("../../state/config-io", () => ({
  readConfigFile: mocks.readConfig,
  writeConfigFile: mocks.writeConfig,
}));
vi.mock("../../state/registry/lock", () => ({
  withLock: (operation: () => unknown) => operation(),
}));
vi.mock("./mcp-bridge-adapters", () => ({
  assertAgentMcpTeardownRuntimeCapability: mocks.assertTeardown,
  registerAgentAdapter: mocks.register,
  reloadOpenClawGatewayAfterMcpMutation: mocks.reloadOpenClaw,
  unregisterAgentAdapter: mocks.unregister,
}));
vi.mock("./mcp-bridge-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-provider")>()),
  assertMcpProviderRecoverable: mocks.assertProviderRecoverable,
  getMcpProviderInspectionRuntimeSelection: () => ({
    gatewayName: "nemoclaw",
    workspace: "default",
  }),
  providerAttached: () => true,
  preflightMcpEntryTargets: mocks.preflightTargets,
  inspectMcpProvider: mocks.inspectProvider,
  detachProvider: mocks.detachProvider,
  waitForDetachedMcpCredential: mocks.waitForDetached,
}));
vi.mock("./mcp-bridge-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-source")>()),
  inspectLegacyBridgeState: mocks.inspectLegacy,
  inspectSourceBridgeState: mocks.inspectSource,
  inspectPolicyOnlyMcpEntry: mocks.inspectPolicyOnly,
  inspectAgentMcpSources: mocks.inspectSources,
  removeLegacyAgentMcpEntry: mocks.removeLegacy,
  joinMcpEntriesToOpenShell: mocks.joinEntries,
}));
vi.mock("./mcp-bridge-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-policy")>()),
  getPolicyPresence: mocks.getPolicyPresence,
  removeGeneratedPolicy: mocks.removePolicy,
}));
vi.mock("../../policy", () => ({
  getPresetContentGatewayState: mocks.getPolicyState,
}));
vi.mock("./mcp-bridge-state", () => ({
  ensureSandboxGatewaySelected: mocks.selectGateway,
  getSandboxAgent: mocks.getAgent,
  getBridgeAdapter: mocks.getAdapter,
  getSandboxOrThrow: mocks.getSandbox,
}));
vi.mock("../../onboard/experimental/portable-agent-lifecycle", () => ({
  assertHermesPortableCommandUnavailable: vi.fn(),
}));

import { migrateMcpBridges } from "./mcp-bridge-migration";
import { removeMcpBridge } from "./mcp-bridge-remove";

describe("explicit MCP migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSandbox.mockReturnValue({ name: "alpha", agent: "openclaw" });
    mocks.getAgent.mockReturnValue({
      name: "openclaw",
      displayName: "OpenClaw",
      mcpCapability: { support: "bridge", adapter: "openclaw-config" },
    });
    mocks.getAdapter.mockReturnValue("openclaw-config");
    mocks.updateSandbox.mockReturnValue(true);
    mocks.readConfig.mockReturnValue({});
    mocks.inspectPolicyOnly.mockResolvedValue(undefined);
    mocks.writeConfig.mockImplementation((_path: string, document: unknown) => {
      mocks.readConfig.mockReturnValue(structuredClone(document));
    });
    mocks.getPolicyPresence.mockResolvedValue(true);
    mocks.getPolicyState.mockResolvedValue("match");
    mocks.joinEntries.mockImplementation((_sandbox: unknown, entries: unknown) => entries);
    mocks.inspectLegacy.mockReturnValue({
      bridges: { github: entry },
      sources: { native: {}, legacy: { github: entry } },
    });
    mocks.inspectSource.mockReturnValue({
      bridges: { github: entry },
      sources: { native: {}, legacy: { github: entry } },
    });
    mocks.inspectSources.mockReturnValue({
      native: { github: { ...entry, source: "native" } },
      legacy: { github: entry },
    });
  });

  it("previews activation without mutating any source", async () => {
    await expect(migrateMcpBridges("alpha")).resolves.toMatchObject({
      applied: false,
      items: [{ server: "github", action: "migrate", activationChanges: true }],
    });
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
  });

  it("does not report activation for an already-native OpenClaw entry", async () => {
    mocks.inspectLegacy.mockReturnValue({
      bridges: { github: entry },
      sources: {
        native: { github: { ...entry, source: "native" } },
        legacy: { github: entry },
      },
    });

    await expect(migrateMcpBridges("alpha")).resolves.toMatchObject({
      items: [{ server: "github", action: "already-migrated", activationChanges: false }],
    });
  });

  it("materializes native config, verifies it, then retires legacy state", async () => {
    const registry =
      await vi.importActual<typeof import("../../state/registry")>("../../state/registry");
    const sibling = { name: "beta", mcp: { bridges: { github: entry } } };
    mocks.readConfig.mockReturnValue({
      sandboxes: { alpha: { name: "alpha", mcp: { bridges: { github: entry } } }, beta: sibling },
    });
    expect(registry.updateSandbox("alpha", { model: "new-model" })).toBe(true);
    expect(mocks.readConfig().sandboxes.alpha.mcp.bridges.github).toEqual(entry);
    await expect(migrateMcpBridges("alpha", { apply: true })).resolves.toMatchObject({
      applied: true,
    });
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.inspectSources).toHaveBeenCalledOnce();
    expect(mocks.reloadOpenClaw).toHaveBeenCalledWith("alpha", ["openclaw-config"]);
    expect(mocks.removeLegacy).toHaveBeenCalledOnce();
    expect(mocks.reloadOpenClaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeLegacy.mock.invocationCallOrder[0],
    );
    expect(mocks.readConfig().sandboxes.alpha).toEqual({ name: "alpha", model: "new-model" });
    expect(mocks.readConfig().sandboxes.beta).toEqual(sibling);
  });

  it("validates restrictive live policy before the first native write", async () => {
    mocks.getPolicyState.mockResolvedValue("drift");

    await expect(migrateMcpBridges("alpha", { apply: true })).rejects.toThrow(
      /does not match the current restrictive OpenShell policy/,
    );
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
  });

  it("preserves changed ownership instead of retiring a different migration snapshot", async () => {
    const original = { bridges: { github: entry } };
    const replacement = { bridges: { github: { ...entry, providerId: "replacement" } } };
    mocks.readConfig.mockReturnValue({ sandboxes: { alpha: { name: "alpha", mcp: original } } });
    mocks.removeLegacy.mockImplementationOnce(async () => {
      mocks.readConfig.mockReturnValue({
        sandboxes: { alpha: { name: "alpha", mcp: replacement } },
      });
    });
    await expect(migrateMcpBridges("alpha", { apply: true })).rejects.toThrow(
      "Legacy MCP ownership changed during migration",
    );
    expect(mocks.writeConfig).not.toHaveBeenCalled();
    expect(mocks.readConfig().sandboxes.alpha.mcp).toEqual(replacement);
  });

  it("retains legacy state when OpenClaw activation fails", async () => {
    mocks.reloadOpenClaw.mockImplementationOnce(() => {
      throw new Error("activation failed");
    });

    await expect(migrateMcpBridges("alpha", { apply: true })).rejects.toThrow("activation failed");
    expect(mocks.unregister).toHaveBeenCalledOnce();
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("removes the Deep Agents legacy projection after verified native migration", async () => {
    const deepEntry = {
      ...entry,
      agent: "langchain-deepagents-code",
      adapter: "deepagents-config" as const,
    };
    mocks.getSandbox.mockReturnValue({ name: "alpha", agent: deepEntry.agent });
    mocks.getAgent.mockReturnValue({
      name: deepEntry.agent,
      displayName: "Deep Agents Code",
      mcpCapability: { support: "bridge", adapter: deepEntry.adapter },
    });
    mocks.getAdapter.mockReturnValue(deepEntry.adapter);
    mocks.readConfig.mockReturnValue({
      sandboxes: { alpha: { name: "alpha", mcp: { bridges: { github: deepEntry } } } },
    });
    mocks.inspectLegacy.mockReturnValue({
      bridges: { github: deepEntry },
      sources: { native: {}, legacy: { github: deepEntry } },
    });
    mocks.inspectSources
      .mockReturnValueOnce({ native: {}, legacy: { github: deepEntry } })
      .mockReturnValue({
        native: { github: { ...deepEntry, source: "native" } },
        legacy: { github: deepEntry },
      });
    const rebuildSandbox = vi.fn().mockResolvedValue(undefined);

    await expect(
      migrateMcpBridges("alpha", { apply: true, rebuildSandbox }),
    ).resolves.toMatchObject({ applied: true });
    expect(rebuildSandbox).toHaveBeenCalledWith("alpha");
    expect(mocks.removeLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ agent: deepEntry.agent }),
      { ...deepEntry, source: "legacy-registry", denyTools: [] },
      expect.any(Object),
    );
    expect(mocks.readConfig().sandboxes.alpha).toEqual({ name: "alpha" });
  });

  it("does not report Deep Agents migration success when legacy cleanup fails", async () => {
    const deepEntry = {
      ...entry,
      agent: "langchain-deepagents-code",
      adapter: "deepagents-config" as const,
    };
    mocks.getSandbox.mockReturnValue({ name: "alpha", agent: deepEntry.agent });
    mocks.getAgent.mockReturnValue({
      name: deepEntry.agent,
      displayName: "Deep Agents Code",
      mcpCapability: { support: "bridge", adapter: deepEntry.adapter },
    });
    mocks.getAdapter.mockReturnValue(deepEntry.adapter);
    mocks.inspectLegacy.mockReturnValue({
      bridges: { github: deepEntry },
      sources: { native: {}, legacy: { github: deepEntry } },
    });
    mocks.inspectSources
      .mockReturnValueOnce({ native: {}, legacy: { github: deepEntry } })
      .mockReturnValue({
        native: { github: { ...deepEntry, source: "native" } },
        legacy: { github: deepEntry },
      });
    mocks.removeLegacy.mockImplementationOnce(() => {
      throw new Error("legacy cleanup failed");
    });

    await expect(
      migrateMcpBridges("alpha", {
        apply: true,
        rebuildSandbox: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow("legacy cleanup failed");
    expect(mocks.unregister).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("preserves every verified Deep Agents native entry after legacy cleanup begins", async () => {
    const deepEntry = {
      ...entry,
      agent: "langchain-deepagents-code",
      adapter: "deepagents-config" as const,
    };
    const secondEntry = {
      ...deepEntry,
      server: "slack",
      url: "https://mcp.slack.example/mcp/",
      env: ["SLACK_TOKEN"],
      providerName: "alpha-mcp-slack",
      providerId: "provider-slack",
      policyName: "mcp-bridge-slack",
    };
    const legacy = { github: deepEntry, slack: secondEntry };
    const native = {
      github: { ...deepEntry, source: "native" as const },
      slack: { ...secondEntry, source: "native" as const },
    };
    mocks.getSandbox.mockReturnValue({ name: "alpha", agent: deepEntry.agent });
    mocks.getAgent.mockReturnValue({
      name: deepEntry.agent,
      displayName: "Deep Agents Code",
      mcpCapability: { support: "bridge", adapter: deepEntry.adapter },
    });
    mocks.getAdapter.mockReturnValue(deepEntry.adapter);
    mocks.inspectLegacy.mockReturnValue({
      bridges: legacy,
      sources: { native: {}, legacy },
    });
    mocks.inspectSources
      .mockReturnValueOnce({ native: {}, legacy })
      .mockReturnValue({ native, legacy });
    mocks.preflightTargets.mockResolvedValue(
      new Map([
        ["github", { addresses: ["8.8.8.8"] }],
        ["slack", { addresses: ["1.1.1.1"] }],
      ]),
    );
    mocks.removeLegacy
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("second legacy cleanup failed");
      });

    await expect(
      migrateMcpBridges("alpha", {
        apply: true,
        rebuildSandbox: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow("second legacy cleanup failed");
    expect(mocks.removeLegacy).toHaveBeenCalledTimes(2);
    expect(mocks.unregister).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("rejects a conflicting native definition before mutation", async () => {
    mocks.inspectLegacy.mockReturnValue({
      bridges: { github: entry },
      sources: {
        native: { github: { ...entry, url: "https://other.example/mcp", source: "native" } },
        legacy: { github: entry },
      },
    });
    await expect(migrateMcpBridges("alpha", { apply: true })).rejects.toThrow(
      /conflicts with legacy server/i,
    );
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("rejects ambiguous credential targets before native registration or legacy cleanup", async () => {
    const secondEntry = {
      ...entry,
      server: "gitlab",
      env: ["GITLAB_TOKEN"],
      providerName: "alpha-mcp-gitlab",
      providerId: "gitlab-provider-id",
      policyName: "mcp-bridge-gitlab",
    };
    mocks.inspectLegacy.mockReturnValue({
      bridges: { github: entry, gitlab: secondEntry },
      sources: { native: {}, legacy: { github: entry, gitlab: secondEntry } },
    });

    await expect(migrateMcpBridges("alpha", { apply: true })).rejects.toThrow(
      /cannot safely choose between credentials for an indistinguishable endpoint/,
    );
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
  });

  it("preserves survivor ownership for migration or a second direct removal", async () => {
    const secondEntry = {
      ...entry,
      server: "gitlab",
      env: ["GITLAB_TOKEN"],
      providerName: "alpha-mcp-gitlab",
      providerId: "gitlab-provider-id",
      policyName: "mcp-bridge-gitlab",
    };
    const legacy = { github: entry, gitlab: secondEntry };
    mocks.inspectSource.mockReturnValue({
      bridges: {},
      sources: { native: {}, legacy },
    });
    const retained = { name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" };
    const otherSandbox = { name: "beta", mcp: { bridges: { github: entry } } };
    mocks.readConfig.mockReturnValue({
      defaultSandbox: "alpha",
      sandboxes: { alpha: { ...retained, mcp: { bridges: legacy } }, beta: otherSandbox },
    });
    mocks.inspectSources.mockResolvedValueOnce({ native: {}, legacy: { github: entry } });
    mocks.inspectProvider.mockResolvedValueOnce({
      exists: true,
      id: secondEntry.providerId,
      resourceVersion: 1,
      type: "generic",
      credentialKeys: secondEntry.env,
    });
    mocks.detachProvider.mockResolvedValueOnce("detached");

    await expect(removeMcpBridge("alpha", "gitlab")).resolves.toBeUndefined();
    expect(mocks.removeLegacy).toHaveBeenCalledExactlyOnceWith(
      { name: "alpha", agent: "openclaw" },
      secondEntry,
      { gatewayName: "nemoclaw", workspace: "default" },
    );
    expect(mocks.unregister).not.toHaveBeenCalled();
    expect(mocks.readConfig()).toEqual({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: { ...retained, mcp: { bridges: { github: entry } } },
        beta: otherSandbox,
      },
    });
    expect(mocks.updateSandbox).not.toHaveBeenCalled();

    const runtimeSelection = { gatewayName: "nemoclaw", workspace: "default" };
    const committedEntry = { ...secondEntry, source: "legacy-registry", denyTools: [] };
    expect(mocks.removePolicy).toHaveBeenCalledExactlyOnceWith("alpha", committedEntry, {
      runtimeSelection,
    });
    expect(mocks.detachProvider).toHaveBeenCalledExactlyOnceWith("alpha", committedEntry, {
      allowLegacyGeneric: true,
      runtimeSelection,
    });
    expect(mocks.waitForDetached).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      committedEntry,
      runtimeSelection,
    );

    mocks.inspectLegacy.mockReturnValue({
      bridges: { github: entry },
      sources: { native: {}, legacy: { github: entry } },
    });
    await expect(migrateMcpBridges("alpha")).resolves.toMatchObject({
      items: [{ server: "github", action: "migrate" }],
    });
    mocks.inspectSource.mockReturnValue({
      bridges: {},
      sources: { native: {}, legacy: { github: entry } },
    });
    mocks.inspectSources.mockResolvedValueOnce({ native: {}, legacy: {} });
    await expect(removeMcpBridge("alpha", "github")).resolves.toBeUndefined();
    expect(mocks.readConfig()).toEqual({
      defaultSandbox: "alpha",
      sandboxes: { alpha: retained, beta: otherSandbox },
    });
    expect(mocks.removeLegacy).toHaveBeenCalledTimes(2);
    expect(mocks.removePolicy).toHaveBeenLastCalledWith(
      "alpha",
      {
        ...entry,
        source: "legacy-registry",
        denyTools: [],
      },
      { runtimeSelection },
    );
  });

  it.each([
    [
      "a committed row changes",
      () =>
        mocks.inspectSources.mockImplementationOnce(async () => {
          mocks.readConfig.mockReturnValue({
            sandboxes: {
              alpha: { mcp: { bridges: { github: { ...entry, providerId: "replacement" } } } },
            },
          });
          return { native: {}, legacy: {} };
        }),
    ],
    [
      "still present",
      () => mocks.inspectSources.mockResolvedValueOnce({ native: {}, legacy: { github: entry } }),
    ],
    [
      "reappears as a native registration",
      () => mocks.inspectSources.mockResolvedValueOnce({ native: { github: entry }, legacy: {} }),
    ],
    [
      "inspection fails",
      () => mocks.inspectSources.mockRejectedValueOnce(new Error("inspection unavailable")),
    ],
    [
      "ownership changes",
      () =>
        mocks.inspectSources.mockImplementationOnce(async () => {
          mocks.readConfig.mockReturnValue({ sandboxes: { alpha: {} } });
          return { native: {}, legacy: {} };
        }),
    ],
  ] as const)(
    "preserves cleanup state when post-removal verification %s",
    async (_outcome, arrangeInspection) => {
      const document = { sandboxes: { alpha: { mcp: { bridges: { github: entry } } } } };
      mocks.readConfig.mockReturnValue(document);
      arrangeInspection();
      await expect(removeMcpBridge("alpha", "github")).rejects.toThrow(
        /remains in agent configuration|inspection unavailable|ownership changed/,
      );
      expect(mocks.writeConfig).not.toHaveBeenCalled();
      expect(mocks.updateSandbox).not.toHaveBeenCalled();
      expect(mocks.removePolicy).not.toHaveBeenCalled();
      expect(mocks.detachProvider).not.toHaveBeenCalled();
    },
  );

  it("removes a native server without changing an unrelated legacy registration", async () => {
    const nativeEntry = {
      ...entry,
      server: "gitlab",
      source: "native" as const,
      env: ["GITLAB_TOKEN"],
      providerName: "alpha-mcp-gitlab",
      providerId: "gitlab-provider-id",
      policyName: "mcp-bridge-gitlab",
    };
    const legacy = { github: entry };
    mocks.inspectSource.mockReturnValue({
      bridges: { gitlab: nativeEntry },
      sources: { native: { gitlab: nativeEntry }, legacy },
    });
    mocks.unregister.mockResolvedValueOnce("removed");

    await expect(removeMcpBridge("alpha", "gitlab")).resolves.toBeUndefined();
    const runtimeSelection = { gatewayName: "nemoclaw", workspace: "default" };
    expect(mocks.unregister).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      "openclaw-config",
      nativeEntry,
      runtimeSelection,
      expect.objectContaining({ teardown: true, force: false }),
    );
    expect(mocks.removePolicy).toHaveBeenCalledExactlyOnceWith("alpha", nativeEntry, {
      runtimeSelection,
    });
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
    expect(legacy).toEqual({ github: entry });
  });

  it("finishes owned cleanup when a registry write fails after source removal", async () => {
    mocks.readConfig.mockReturnValue({
      sandboxes: { alpha: { mcp: { bridges: { github: entry } } } },
    });
    mocks.inspectSources.mockResolvedValue({ native: {}, legacy: {} });
    mocks.removeLegacy.mockImplementationOnce(async () => {
      mocks.inspectSource.mockReturnValue({ bridges: {}, sources: { native: {}, legacy: {} } });
    });
    mocks.writeConfig.mockImplementationOnce(() => {
      throw new Error("registry disk failure");
    });
    await expect(removeMcpBridge("alpha", "github")).rejects.toThrow("registry disk failure");
    expect(mocks.removePolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    mocks.inspectPolicyOnly.mockResolvedValueOnce({ ...entry, source: "policy" });
    mocks.inspectProvider.mockResolvedValue({
      exists: true,
      id: entry.providerId,
      resourceVersion: 1,
      type: "generic",
      credentialKeys: entry.env,
    });
    mocks.detachProvider.mockResolvedValueOnce("detached");
    await expect(removeMcpBridge("alpha", "github")).resolves.toBeUndefined();
    expect(mocks.readConfig()).toEqual({ sandboxes: { alpha: {} } });
    expect(mocks.removeLegacy).toHaveBeenCalledOnce();
    expect(mocks.removePolicy).toHaveBeenCalledOnce();
    expect(mocks.detachProvider).toHaveBeenCalledOnce();
    expect(mocks.waitForDetached).toHaveBeenCalledOnce();
    expect(mocks.unregister).not.toHaveBeenCalled();
  });

  it("removes an owned legacy entry after an unrelated real registry update", async () => {
    const registry =
      await vi.importActual<typeof import("../../state/registry")>("../../state/registry");
    mocks.readConfig.mockReturnValue({
      sandboxes: { alpha: { name: "alpha", mcp: { bridges: { github: entry } } } },
    });
    expect(registry.updateSandbox("alpha", { agentVersion: "new-version" })).toBe(true);
    mocks.inspectSources.mockResolvedValueOnce({ native: {}, legacy: {} });
    await expect(removeMcpBridge("alpha", "github")).resolves.toBeUndefined();
    expect(mocks.readConfig().sandboxes.alpha).toEqual({
      name: "alpha",
      agentVersion: "new-version",
    });
    expect(mocks.removeLegacy).toHaveBeenCalledOnce();
    expect(mocks.removePolicy).toHaveBeenCalledOnce();
  });

  it("preserves a registry-only row when the policy's recorded provider identity changed", async () => {
    mocks.readConfig.mockReturnValue({
      sandboxes: { alpha: { mcp: { bridges: { github: entry } } } },
    });
    mocks.inspectSource.mockReturnValue({ bridges: {}, sources: { native: {}, legacy: {} } });
    mocks.inspectPolicyOnly.mockResolvedValueOnce({
      ...entry,
      source: "policy",
      providerId: "replacement",
    });
    await expect(removeMcpBridge("alpha", "github")).rejects.toThrow("no longer matches");
    expect(mocks.writeConfig).not.toHaveBeenCalled();
    expect(mocks.removePolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("preserves a registry-only row when the live provider identity changed", async () => {
    mocks.readConfig.mockReturnValue({
      sandboxes: { alpha: { mcp: { bridges: { github: entry } } } },
    });
    mocks.inspectSource.mockReturnValue({ bridges: {}, sources: { native: {}, legacy: {} } });
    mocks.inspectProvider.mockResolvedValueOnce({
      exists: true,
      id: "replacement",
      resourceVersion: 1,
      type: "generic",
      credentialKeys: entry.env,
    });

    await expect(removeMcpBridge("alpha", "github")).rejects.toThrow("provider identity changed");
    expect(mocks.writeConfig).not.toHaveBeenCalled();
    expect(mocks.removePolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("rejects legacy removal before mutation when another registry-only row remains", async () => {
    const registryOnlyEntry = {
      ...entry,
      server: "gitlab",
      url: "https://gitlab.example.test/mcp",
      env: ["GITLAB_TOKEN"],
      providerName: "alpha-mcp-gitlab",
      providerId: "gitlab-provider-id",
      policyName: "mcp-bridge-gitlab",
    };
    mocks.inspectSource.mockReturnValue({
      bridges: {},
      sources: { native: {}, legacy: { github: entry } },
    });
    mocks.readConfig.mockReturnValue({
      sandboxes: { alpha: { mcp: { bridges: { github: entry, gitlab: registryOnlyEntry } } } },
    });

    await expect(removeMcpBridge("alpha", "github")).rejects.toThrow(
      /registry-only legacy registration.*gitlab.*No source was changed/,
    );
    expect(mocks.selectGateway).not.toHaveBeenCalled();
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
    expect(mocks.unregister).not.toHaveBeenCalled();
  });

  it("preserves a named legacy entry without matching registry ownership", async () => {
    mocks.readConfig.mockReturnValue({});

    await expect(removeMcpBridge("alpha", "github")).rejects.toThrow(
      /cannot be proven as registry-owned and was preserved/,
    );
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
    expect(mocks.unregister).not.toHaveBeenCalled();
  });

  it("preserves legacy source and ownership when teardown capability fails", async () => {
    mocks.readConfig.mockReturnValue({
      sandboxes: { alpha: { mcp: { bridges: { github: entry } } } },
    });
    mocks.assertTeardown.mockRejectedValueOnce(new Error("teardown capability unavailable"));
    await expect(removeMcpBridge("alpha", "github")).rejects.toThrow(
      "teardown capability unavailable",
    );
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
    expect(mocks.unregister).not.toHaveBeenCalled();
    expect(mocks.removePolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("preserves dual legacy and native registrations before any removal", async () => {
    mocks.inspectSource.mockReturnValue({
      bridges: { github: entry },
      sources: { legacy: { github: entry }, native: { github: { ...entry, source: "native" } } },
    });
    mocks.readConfig.mockReturnValue({
      sandboxes: { alpha: { mcp: { bridges: { github: entry } } } },
    });
    await expect(removeMcpBridge("alpha", "github")).rejects.toThrow(/both legacy and native/);
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
    expect(mocks.unregister).not.toHaveBeenCalled();
    expect(mocks.removePolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("enriches native ownership before rejecting a differently credentialed alias", async () => {
    const nativeEntry = {
      server: "gitlab",
      agent: "openclaw",
      adapter: "openclaw-config" as const,
      url: entry.url,
      env: ["GITLAB_TOKEN"],
      policyName: "mcp-bridge-gitlab",
      source: "native" as const,
    };
    mocks.inspectLegacy.mockReturnValue({
      bridges: { github: entry },
      sources: { native: { gitlab: nativeEntry }, legacy: { github: entry } },
    });
    mocks.joinEntries.mockImplementation((_sandbox: unknown, entries: unknown) => {
      const sourceEntries = entries as Record<string, typeof nativeEntry>;
      return sourceEntries.gitlab
        ? {
            gitlab: {
              ...sourceEntries.gitlab,
              providerName: "alpha-mcp-gitlab",
              providerId: "gitlab-provider-id",
            },
          }
        : entries;
    });

    await expect(migrateMcpBridges("alpha")).rejects.toThrow(
      /cannot safely choose between credentials for an indistinguishable endpoint/,
    );
    await expect(migrateMcpBridges("alpha", { apply: true })).rejects.toThrow(
      /cannot safely choose between credentials for an indistinguishable endpoint/,
    );
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
  });

  it("previews a valid committed registry-only row for explicit migration", async () => {
    mocks.inspectLegacy.mockReturnValue({
      bridges: {},
      sources: { native: {}, legacy: {} },
    });
    mocks.readConfig.mockReturnValue({
      sandboxes: {
        alpha: {
          mcp: {
            bridges: {
              github: {
                ...entry,
                adapter: "mcporter",
                source: undefined,
              },
            },
          },
        },
      },
    });
    await expect(migrateMcpBridges("alpha")).resolves.toMatchObject({
      applied: false,
      items: [{ server: "github", source: "legacy-registry", action: "migrate" }],
    });
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("rejects stale registry denied tools when live policy is authoritative (#11115)", async () => {
    mocks.inspectLegacy.mockReturnValue({
      bridges: {},
      sources: { native: {}, legacy: {} },
    });
    mocks.readConfig.mockReturnValue({
      sandboxes: {
        alpha: {
          mcp: {
            bridges: {
              github: {
                ...entry,
                adapter: "mcporter",
                source: undefined,
                denyTools: ["old_tool"],
                pendingDenyTools: ["replacement_*"],
              },
            },
          },
        },
      },
    });
    mocks.joinEntries.mockImplementation((_sandbox: unknown, entries: unknown) => {
      const map = entries as Record<string, { source?: string; denyTools?: string[] }>;
      return Object.fromEntries(
        Object.entries(map).map(([server, value]) => [
          server,
          value.source === "legacy-registry" ? { ...value, denyTools: ["live_tool"] } : value,
        ]),
      );
    });

    await expect(migrateMcpBridges("alpha", { apply: true })).rejects.toThrow(
      /denied-tool intent conflicts with the current OpenShell policy/,
    );
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid server name", "not valid!", entry.url],
    ["cleartext URL", "github", "http://api.githubcopilot.com/mcp/"],
  ])("rejects a committed registry row with an %s", async (_label, server, url) => {
    mocks.inspectLegacy.mockReturnValue({
      bridges: {},
      sources: { native: {}, legacy: {} },
    });
    mocks.readConfig.mockReturnValue({
      sandboxes: {
        alpha: {
          mcp: {
            bridges: {
              [server]: { ...entry, server, url, adapter: "mcporter", source: undefined },
            },
          },
        },
      },
    });

    await expect(migrateMcpBridges("alpha", { apply: true })).rejects.toThrow(
      /not a valid committed registration|unsupported URL/i,
    );
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("preserves a verified native entry once legacy cleanup has started", async () => {
    mocks.removeLegacy.mockImplementationOnce(() => {
      throw new Error("legacy cleanup failed");
    });

    await expect(migrateMcpBridges("alpha", { apply: true })).rejects.toThrow(
      "legacy cleanup failed",
    );
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.unregister).not.toHaveBeenCalled();
  });
});
