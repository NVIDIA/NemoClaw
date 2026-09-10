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
}));

import { migrateMcpBridges } from "./mcp-bridge-migration";

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
    mocks.getPolicyPresence.mockReturnValue(true);
    mocks.getPolicyState.mockReturnValue("match");
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

  it("materializes native config, verifies it, then retires legacy state", async () => {
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
    expect(mocks.updateSandbox).toHaveBeenCalledWith("alpha", {});
  });

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

    await expect(
      migrateMcpBridges("alpha", { apply: true, rebuildSandbox }),
    ).resolves.toMatchObject({ applied: true });
    expect(rebuildSandbox).toHaveBeenCalledWith("alpha");
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
