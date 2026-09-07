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
  getSandbox: vi.fn(),
  updateSandbox: vi.fn(),
  inspectLegacy: vi.fn(),
  inspectSources: vi.fn(),
  removeLegacy: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  selectGateway: vi.fn(),
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
  unregisterAgentAdapter: mocks.unregister,
}));
vi.mock("./mcp-bridge-provider", () => ({
  getMcpProviderInspectionRuntimeSelection: () => ({
    gatewayName: "nemoclaw",
    workspace: "default",
  }),
  providerAttached: () => false,
}));
vi.mock("./mcp-bridge-source", () => ({
  inspectLegacyBridgeState: mocks.inspectLegacy,
  inspectAgentMcpSources: mocks.inspectSources,
  removeLegacyAgentMcpEntry: mocks.removeLegacy,
  joinMcpEntriesToOpenShell: (_sandbox: unknown, entries: unknown) => entries,
}));
vi.mock("./mcp-bridge-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-policy")>()),
  getPolicyPresence: () => false,
}));
vi.mock("./mcp-bridge-state", () => ({
  ensureSandboxGatewaySelected: mocks.selectGateway,
  getSandboxAgent: () => ({
    name: "openclaw",
    displayName: "OpenClaw",
    mcpCapability: { support: "bridge", adapter: "openclaw-config" },
  }),
  getBridgeAdapter: () => "openclaw-config",
}));

import { migrateMcpBridges } from "./mcp-bridge-migration";

describe("explicit MCP migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSandbox.mockReturnValue({ name: "alpha", agent: "openclaw" });
    mocks.updateSandbox.mockReturnValue(true);
    mocks.readConfig.mockReturnValue({});
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

  it("materializes native config, verifies it, then retires legacy state", async () => {
    await expect(migrateMcpBridges("alpha", { apply: true })).resolves.toMatchObject({
      applied: true,
    });
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.inspectSources).toHaveBeenCalledOnce();
    expect(mocks.removeLegacy).toHaveBeenCalledOnce();
    expect(mocks.updateSandbox).toHaveBeenCalledWith("alpha", {});
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
});
