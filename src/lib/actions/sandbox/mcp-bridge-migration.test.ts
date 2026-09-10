// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

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
  resolveTarget: vi.fn(),
  getPolicyPresence: vi.fn(() => true),
  getPolicyState: vi.fn(() => "match"),
  getAgent: vi.fn(),
  getAdapter: vi.fn(),
  updateSandbox: vi.fn(),
  inspectLegacy: vi.fn(),
  inspectSources: vi.fn(),
  joinEntries: vi.fn((_sandbox: unknown, entries: unknown) => entries),
  removeLegacy: vi.fn(),
  register: vi.fn(),
  waitForCredential: vi.fn(),
  discoverTools: vi.fn(),
  reloadOpenClaw: vi.fn(),
  unregister: vi.fn(),
  selectGateway: vi.fn(),
  preflightTargets: vi.fn().mockResolvedValue(new Map([["github", { addresses: ["8.8.8.8"] }]])),
  readConfig: vi.fn(),
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
}));
vi.mock("./mcp-bridge-adapters", () => ({
  registerAgentAdapter: mocks.register,
  registerAgentAdapterAtCurrentCredentialRevision: mocks.register,
  reloadOpenClawGatewayAfterMcpMutation: mocks.reloadOpenClaw,
  unregisterAgentAdapter: mocks.unregister,
}));
vi.mock("./mcp-bridge-provider", () => ({
  assertMcpProviderRecoverable: mocks.assertProviderRecoverable,
  getMcpProviderInspectionRuntimeSelection: () => ({
    gatewayName: "nemoclaw",
    workspace: "default",
  }),
  providerAttached: () => true,
  preflightMcpEntryTargets: mocks.preflightTargets,
  waitForAttachedMcpCredential: mocks.waitForCredential,
}));
vi.mock("./mcp-bridge-tool-discovery", () => ({
  discoverMcpTools: mocks.discoverTools,
}));
vi.mock("./mcp-bridge-source", () => ({
  inspectLegacyBridgeState: mocks.inspectLegacy,
  inspectAgentMcpSources: mocks.inspectSources,
  removeLegacyAgentMcpEntry: mocks.removeLegacy,
  joinMcpEntriesToOpenShell: mocks.joinEntries,
}));
vi.mock("./mcp-bridge-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-policy")>()),
  getPolicyPresence: mocks.getPolicyPresence,
}));
vi.mock("../../policy", () => ({
  getPresetContentGatewayState: mocks.getPolicyState,
}));
vi.mock("./mcp-bridge-state", () => ({
  ensureSandboxGatewaySelected: mocks.selectGateway,
  getSandboxAgent: mocks.getAgent,
  getBridgeAdapter: mocks.getAdapter,
  getSandboxOrThrow: mocks.resolveTarget,
  resolveMcpOperationTarget: (name: string) => ({
    sandbox: mocks.resolveTarget(name),
    runtimeSelection: { gatewayName: "nemoclaw", workspace: "default" },
    ...(mocks.getSandbox(name)
      ? {}
      : { liveIdentity: { sandboxId: "live-alpha", assertCurrent() {} } }),
  }),
}));

import {
  migrateMcpBridges,
  readCommittedLegacyRegistryEntries,
  validateMcpMigrationRebuildIntent,
  type McpMigrationRebuildIntent,
} from "./mcp-bridge-migration";

describe("explicit MCP migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSandbox.mockReturnValue({ name: "alpha", agent: "openclaw" });
    mocks.resolveTarget.mockImplementation((name) => mocks.getSandbox(name));
    mocks.getAgent.mockReturnValue({
      name: "openclaw",
      displayName: "OpenClaw",
      mcpCapability: { support: "bridge", adapter: "openclaw-config" },
    });
    mocks.getAdapter.mockReturnValue("openclaw-config");
    mocks.updateSandbox.mockReturnValue(true);
    mocks.readConfig.mockReturnValue({});
    mocks.getPolicyPresence.mockReturnValue(true);
    mocks.getPolicyState.mockReturnValue("match");
    mocks.register.mockReset();
    mocks.waitForCredential.mockReset().mockResolvedValue("v12");
    mocks.discoverTools.mockReset().mockReturnValue({
      ok: true,
      count: 1,
      tools: ["lookup"],
      truncated: false,
      commandStatus: 0,
    });
    mocks.joinEntries.mockImplementation((_sandbox: unknown, entries: unknown) => entries);
    mocks.inspectLegacy.mockReturnValue({
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

  it.each([false, true])(
    "handles agent legacy sources without a registry row (apply=%s)",
    async (apply) => {
      mocks.getSandbox.mockReturnValue(undefined);
      mocks.resolveTarget.mockReturnValue({
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw",
      });

      await expect(migrateMcpBridges("alpha", { apply })).resolves.toMatchObject({
        applied: apply,
        items: [{ server: "github", source: "legacy-agent" }],
      });
      expect(mocks.register).toHaveBeenCalledTimes(Number(apply));
      expect(mocks.updateSandbox).not.toHaveBeenCalled();
    },
  );

  it("refuses migration when committed registry intent cannot be read", async () => {
    const failure = new Error("committed legacy registry is corrupt");
    mocks.readConfig.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(migrateMcpBridges("alpha", { apply: true })).rejects.toBe(failure);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it.each([
    ["null document", null],
    ["array document", []],
    ["scalar document", "private-legacy-marker"],
    ["array sandbox map", { sandboxes: [] }],
    ["null sandbox map", { sandboxes: null }],
    ["array sandbox row", { sandboxes: { alpha: [] } }],
    ["null sandbox row", { sandboxes: { alpha: null } }],
    ["array MCP state", { sandboxes: { alpha: { mcp: [] } } }],
    ["null MCP state", { sandboxes: { alpha: { mcp: null } } }],
    ["scalar MCP state", { sandboxes: { alpha: { mcp: "private-legacy-marker" } } }],
    ["missing bridge map", { sandboxes: { alpha: { mcp: {} } } }],
    ["array bridge map", { sandboxes: { alpha: { mcp: { bridges: [] } } } }],
    ["null bridge map", { sandboxes: { alpha: { mcp: { bridges: null } } } }],
  ])("refuses malformed legacy registry %s before changing sources", async (_label, document) => {
    mocks.readConfig.mockReturnValue(document);
    const before = structuredClone(document);

    await expect(migrateMcpBridges("alpha", { apply: true })).rejects.toMatchObject({
      message: "Legacy MCP registry structure for 'alpha' is invalid. No source was changed.",
      exitCode: 2,
    });

    expect(document).toEqual(before);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
    expect(mocks.reloadOpenClaw).not.toHaveBeenCalled();
    expect(mocks.discoverTools).not.toHaveBeenCalled();
  });

  it.each([
    ["absent registry", {}],
    ["absent sandbox", { sandboxes: {} }],
    ["absent MCP state", { sandboxes: { alpha: {} } }],
    ["empty bridge map", { sandboxes: { alpha: { mcp: { bridges: {} } } } }],
  ])("keeps an %s migration inventory empty", (_label, document) => {
    mocks.readConfig.mockReturnValue(document);
    const before = structuredClone(document);

    expect(readCommittedLegacyRegistryEntries("alpha", "openclaw", "openclaw-config")).toEqual({});
    expect(document).toEqual(before);
  });

  it("materializes native config, verifies it, then retires legacy state", async () => {
    let finishRegistration!: () => void;
    let finishReload!: () => void;
    mocks.register.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishRegistration = resolve;
      }),
    );
    mocks.reloadOpenClaw.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishReload = resolve;
      }),
    );
    const migration = migrateMcpBridges("alpha", { apply: true });
    try {
      await vi.waitFor(() => expect(mocks.register).toHaveBeenCalledOnce());
      expect(mocks.inspectSources).not.toHaveBeenCalled();
      expect(mocks.reloadOpenClaw).not.toHaveBeenCalled();
      expect(mocks.removeLegacy).not.toHaveBeenCalled();
      finishRegistration();
      await vi.waitFor(() => expect(mocks.reloadOpenClaw).toHaveBeenCalledOnce());
      expect(mocks.discoverTools).not.toHaveBeenCalled();
      expect(mocks.removeLegacy).not.toHaveBeenCalled();
      finishReload();
      await expect(migration).resolves.toMatchObject({ applied: true });
    } finally {
      finishRegistration();
      finishReload();
      await migration.catch(() => undefined);
    }
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.register).toHaveBeenCalledWith(
      "alpha",
      "openclaw-config",
      entry,
      expect.any(Object),
      {},
      "v12",
      { replaceExisting: false },
    );
    expect(mocks.inspectSources).toHaveBeenCalledOnce();
    expect(mocks.reloadOpenClaw).toHaveBeenCalledWith("alpha", ["openclaw-config"]);
    expect(mocks.removeLegacy).toHaveBeenCalledOnce();
    expect(mocks.reloadOpenClaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.discoverTools.mock.invocationCallOrder[0],
    );
    expect(mocks.discoverTools.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeLegacy.mock.invocationCallOrder[0],
    );
    expect(mocks.updateSandbox).toHaveBeenCalledWith("alpha", {});
  });

  it("retains legacy configuration when its credential is not ready for native registration", async () => {
    mocks.waitForCredential.mockRejectedValueOnce(new Error("attached credential unavailable"));

    await expect(migrateMcpBridges("alpha", { apply: true })).rejects.toThrow(
      "attached credential unavailable",
    );
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.discoverTools).not.toHaveBeenCalled();
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("retains legacy configuration when live policy changes after native activation", async () => {
    mocks.getPolicyState.mockReturnValueOnce("match").mockReturnValue("drift");
    let finishRegistration!: () => void;
    mocks.register.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishRegistration = resolve;
      }),
    );
    const migration = migrateMcpBridges("alpha", { apply: true });
    const outcome = migration.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await vi.waitFor(() => expect(mocks.register).toHaveBeenCalledOnce());
      expect(mocks.unregister).not.toHaveBeenCalled();
      expect(mocks.removeLegacy).not.toHaveBeenCalled();
      finishRegistration();
      expect(await outcome).toMatchObject({
        message: expect.stringMatching(/does not match the current restrictive OpenShell policy/),
      });
    } finally {
      finishRegistration();
      await outcome;
    }
    expect(mocks.reloadOpenClaw).toHaveBeenCalledOnce();
    expect(mocks.discoverTools).not.toHaveBeenCalled();
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
    expect(mocks.unregister).toHaveBeenCalledOnce();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it.each([
    { agent: "openclaw", adapter: "openclaw-config" as const },
    { agent: "langchain-deepagents-code", adapter: "deepagents-config" as const },
  ])(
    "retains legacy $agent configuration when authenticated discovery fails",
    async ({ agent, adapter }) => {
      const legacyEntry = { ...entry, agent, adapter };
      const legacy = { github: legacyEntry };
      const native: Record<string, Omit<typeof legacyEntry, "source"> & { source: "native" }> = {};
      mocks.getSandbox.mockReturnValue({ name: "alpha", agent });
      mocks.getAgent.mockReturnValue({ name: agent });
      mocks.getAdapter.mockReturnValue(adapter);
      mocks.inspectLegacy.mockReturnValue({ bridges: legacy, sources: { native: {}, legacy } });
      mocks.inspectSources.mockImplementation(() => ({ native, legacy }));
      mocks.register.mockImplementation(() => {
        native.github = { ...legacyEntry, source: "native" };
      });
      mocks.discoverTools.mockReturnValue({
        ok: false,
        count: 0,
        tools: [],
        truncated: false,
        commandStatus: 1,
        failedStage: "initialization",
        failureClass: "authentication",
        detail: "MCP endpoint rejected the request (HTTP 401)",
      });
      mocks.unregister.mockImplementationOnce(() => {
        throw new Error("native rollback failed");
      });

      await expect(
        migrateMcpBridges("alpha", {
          apply: true,
          rebuildSandbox: vi.fn().mockResolvedValue(undefined),
        }),
      ).rejects.toThrow(/authenticated tool discovery/);
      expect(mocks.removeLegacy).not.toHaveBeenCalled();
      expect(mocks.unregister).toHaveBeenCalledOnce();
      expect(legacy).toEqual({ github: legacyEntry });
      expect(mocks.updateSandbox).not.toHaveBeenCalled();
    },
  );

  it("validates restrictive live policy before the first native write", async () => {
    mocks.getPolicyState.mockReturnValue("drift");

    await expect(migrateMcpBridges("alpha", { apply: true })).rejects.toThrow(
      /does not match the current restrictive OpenShell policy/,
    );
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.removeLegacy).not.toHaveBeenCalled();
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

    let finishRegistration!: () => void;
    mocks.register.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishRegistration = resolve;
      }),
    );
    const migration = migrateMcpBridges("alpha", { apply: true, rebuildSandbox });
    try {
      await vi.waitFor(() => expect(mocks.register).toHaveBeenCalledOnce());
      expect(mocks.inspectSources).toHaveBeenCalledOnce();
      expect(mocks.discoverTools).not.toHaveBeenCalled();
      expect(mocks.removeLegacy).not.toHaveBeenCalled();
      finishRegistration();
      await expect(migration).resolves.toMatchObject({ applied: true });
    } finally {
      finishRegistration();
      await migration.catch(() => undefined);
    }
    expect(rebuildSandbox).toHaveBeenCalledWith("alpha", {
      sandboxName: "alpha",
      entries: [deepEntry],
      runtimeSelection: { gatewayName: "nemoclaw", workspace: "default" },
    });
    expect(mocks.removeLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ agent: deepEntry.agent }),
      deepEntry,
      expect.any(Object),
    );
    expect(mocks.updateSandbox).toHaveBeenCalledWith("alpha", {});
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

  it("previews a valid committed registry-only row for explicit migration", async () => {
    mocks.inspectLegacy.mockReturnValue({
      bridges: {},
      sources: { native: {}, legacy: {} },
    });
    const document = {
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
    };
    const before = structuredClone(document);
    mocks.readConfig.mockReturnValue(document);
    await expect(migrateMcpBridges("alpha")).resolves.toMatchObject({
      applied: false,
      items: [{ server: "github", source: "legacy-registry", action: "migrate" }],
    });
    expect(mocks.register).not.toHaveBeenCalled();
    expect(document).toEqual(before);
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

  it("preserves verified native state when legacy registry retirement writes then fails", async () => {
    let legacyRegistry: unknown = {
      sandboxes: {
        alpha: { mcp: { bridges: { github: { ...entry, adapter: "mcporter" } } } },
      },
    };
    mocks.inspectLegacy.mockReturnValue({
      bridges: {},
      sources: { native: {}, legacy: {} },
    });
    mocks.readConfig.mockImplementation(() => legacyRegistry);
    mocks.updateSandbox.mockImplementationOnce(() => {
      legacyRegistry = { sandboxes: { alpha: {} } };
      throw new Error("registry publication failed after rename");
    });

    await expect(migrateMcpBridges("alpha", { apply: true })).rejects.toThrow(
      "registry publication failed after rename",
    );
    expect(legacyRegistry).toEqual({ sandboxes: { alpha: {} } });
    expect(mocks.discoverTools).toHaveBeenCalledOnce();
    expect(mocks.unregister).not.toHaveBeenCalled();
  });

  describe("explicit rebuild intent", () => {
    const deepEntry = {
      ...entry,
      agent: "langchain-deepagents-code",
      adapter: "deepagents-config" as const,
    };
    const runtimeSelection = { gatewayName: "nemoclaw", workspace: "default" };
    const intent: McpMigrationRebuildIntent = {
      sandboxName: "alpha",
      entries: [deepEntry],
      runtimeSelection,
    };

    beforeEach(() => {
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
      mocks.assertProviderRecoverable.mockReset().mockResolvedValue({ exists: true });
    });

    it("revalidates the complete legacy plan and live enforcement without changing sources", async () => {
      await expect(
        validateMcpMigrationRebuildIntent("alpha", intent, runtimeSelection),
      ).resolves.toBeUndefined();
      expect(mocks.assertProviderRecoverable).toHaveBeenCalledWith(deepEntry, runtimeSelection);
      expect(mocks.getPolicyState).toHaveBeenCalledOnce();
      expect(mocks.register).not.toHaveBeenCalled();
      expect(mocks.removeLegacy).not.toHaveBeenCalled();
      expect(mocks.updateSandbox).not.toHaveBeenCalled();
    });

    it("qualifies registry-only legacy intent before transferring it to the rebuild handoff", async () => {
      const registryEntry = { ...deepEntry, source: "legacy-registry" as const };
      mocks.inspectLegacy.mockReturnValue({
        bridges: {},
        sources: { native: {}, legacy: {} },
      });
      mocks.readConfig.mockReturnValue({
        sandboxes: { alpha: { mcp: { bridges: { github: registryEntry } } } },
      });
      await expect(
        validateMcpMigrationRebuildIntent(
          "alpha",
          { ...intent, entries: [registryEntry] },
          runtimeSelection,
        ),
      ).resolves.toBeUndefined();
      expect(mocks.assertProviderRecoverable).toHaveBeenCalledWith(registryEntry, runtimeSelection);
      expect(mocks.register).not.toHaveBeenCalled();
      expect(mocks.removeLegacy).not.toHaveBeenCalled();
      expect(mocks.updateSandbox).not.toHaveBeenCalled();
    });

    it.each([
      ["missing legacy source", {}],
      ["changed legacy URL", { github: { ...deepEntry, url: "https://changed.example.test/mcp" } }],
      ["omitted legacy entry", { github: deepEntry, second: { ...deepEntry, server: "second" } }],
    ])("refuses %s before any rebuild mutation", async (_label, bridges) => {
      mocks.inspectLegacy.mockReturnValue({ bridges, sources: { native: {}, legacy: bridges } });
      await expect(
        validateMcpMigrationRebuildIntent("alpha", intent, runtimeSelection),
      ).rejects.toThrow("MCP migration sources changed");
      expect(mocks.assertProviderRecoverable).not.toHaveBeenCalled();
      expect(mocks.register).not.toHaveBeenCalled();
      expect(mocks.removeLegacy).not.toHaveBeenCalled();
    });

    it.each([
      ["wrong sandbox", { ...intent, sandboxName: "other" }],
      ["empty inventory", { ...intent, entries: [] }],
      ["non-legacy intent", { ...intent, entries: [{ ...deepEntry, source: "native" as const }] }],
      [
        "another gateway",
        { ...intent, runtimeSelection: { ...runtimeSelection, gatewayName: "other" } },
      ],
      [
        "another workspace",
        { ...intent, runtimeSelection: { ...runtimeSelection, workspace: "other" } },
      ],
      [
        "another TLS scope",
        { ...intent, runtimeSelection: { ...runtimeSelection, localTlsDir: "/other" } },
      ],
      [
        "literal credential",
        { ...intent, entries: [{ ...deepEntry, env: ["private-credential-value"] }] },
      ],
      [
        "raw header",
        {
          ...intent,
          entries: [{ ...deepEntry, headers: { Authorization: "private-header-value" } }],
        },
      ],
      [
        "stdio command",
        { ...intent, entries: [{ ...deepEntry, command: "untrusted-command", args: [] }] },
      ],
    ])("refuses %s as migration rebuild authority", async (_label, candidate) => {
      await expect(
        validateMcpMigrationRebuildIntent("alpha", candidate, runtimeSelection),
      ).rejects.toThrow("MCP migration rebuild intent is invalid");
      expect(mocks.inspectLegacy).not.toHaveBeenCalled();
      expect(mocks.register).not.toHaveBeenCalled();
      expect(mocks.removeLegacy).not.toHaveBeenCalled();
    });

    it("retains live provider and policy refusals before source replacement", async () => {
      mocks.assertProviderRecoverable.mockRejectedValueOnce(new Error("provider identity changed"));
      await expect(
        validateMcpMigrationRebuildIntent("alpha", intent, runtimeSelection),
      ).rejects.toThrow("provider identity changed");
      mocks.getPolicyState.mockReturnValueOnce("drift");
      await expect(
        validateMcpMigrationRebuildIntent("alpha", intent, runtimeSelection),
      ).rejects.toThrow("does not match");
      expect(mocks.register).not.toHaveBeenCalled();
      expect(mocks.removeLegacy).not.toHaveBeenCalled();
    });
  });
});
