// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
  observe: vi.fn(),
  wait: vi.fn(),
  refresh: vi.fn(),
  reload: vi.fn(),
  status: vi.fn(),
  inspectSources: vi.fn(),
  preflightTargets: vi.fn(),
}));

vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withMcpLifecycleLock: async (_name: string, operation: () => Promise<unknown>) => operation(),
}));
vi.mock("../../onboard/experimental/portable-agent-lifecycle", () => ({
  assertHermesPortableCommandUnavailable: vi.fn(),
}));
vi.mock("./mcp-bridge-adapters", () => ({
  registerAgentAdapterAtCurrentCredentialRevision: mocks.register,
  unregisterAgentAdapter: mocks.unregister,
  reloadOpenClawGatewayAfterMcpMutation: mocks.reload,
}));
vi.mock("./mcp-bridge-policy", () => ({
  applyGeneratedPolicy: vi.fn(),
  assertGeneratedPolicyMutationSafe: vi.fn(),
}));
vi.mock("./mcp-bridge-provider", () => ({
  assertMcpProviderRecoverable: vi.fn(() => ({ exists: true })),
  assertNoAttachedProviderCredentialCollisions: vi.fn(),
  assertNoProviderCredentialCollisions: vi.fn(),
  attachProvider: vi.fn(),
  detachMissingProviderReference: vi.fn(),
  ensureMcpBridgeProviderProfile: vi.fn(),
  getMcpProviderInspectionRuntimeSelection: vi.fn(() => ({
    gatewayName: "nemoclaw",
    workspace: "default",
  })),
  observeMcpCredentialRevision: mocks.observe,
  preflightMcpEntryTargets: mocks.preflightTargets,
  refreshMcpProviderEnvironment: mocks.refresh,
  upsertMcpProvider: vi.fn(),
  waitForAttachedMcpCredential: mocks.wait,
  waitForDetachedMcpCredential: vi.fn(),
}));
vi.mock("./mcp-bridge-runtime-capabilities", () => ({
  assertMcpAdapterMutationRuntimeCapabilities: vi.fn(),
  assertMcpAdapterTeardownRuntimeCapabilities: vi.fn(),
}));
vi.mock("./mcp-bridge-state", () => ({
  ensureSandboxGatewaySelected: vi.fn(),
  getBridgeAdapter: vi.fn(() => "openclaw-config"),
  getSandboxAgent: vi.fn(() => ({
    name: "openclaw",
    mcpCapability: { support: "bridge", adapter: "openclaw-config" },
  })),
  getSandboxOrThrow: vi.fn(() => ({ name: "alpha", agent: "openclaw" })),
}));
vi.mock("./mcp-bridge-source", () => ({
  inspectSourceBridgeState: mocks.inspectSources,
}));
vi.mock("./mcp-bridge-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-status")>()),
  statusMcpBridge: mocks.status,
}));
vi.mock("./mcp-bridge-validation", () => ({
  assertAuthenticatedBridgeEntry: vi.fn(),
  assertMcpCredentialBoundaryRuntimeVersion: vi.fn(),
  resolveCredentialEnv: vi.fn(() => ({})),
  validateSandboxName: vi.fn(),
}));

import { restartMcpBridge, restoreExistingMcpBridgeRuntime } from "./mcp-bridge-restart";

const entries = ["first", "second"].map((server) => ({
  server,
  agent: "openclaw",
  adapter: "openclaw-config" as const,
  url: `https://${server}.example.test/mcp`,
  env: [`${server.toUpperCase()}_TOKEN`],
  allowedIps: [server === "first" ? "1.1.1.1" : "8.8.8.8"],
  providerName: `alpha-mcp-${server}`,
  providerId: `${server}-provider-id`,
  policyName: `mcp-bridge-${server}`,
  source: "native" as const,
}));

describe("OpenClaw MCP partial-mutation recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.observe.mockReset().mockResolvedValue("v1");
    mocks.wait.mockReset().mockResolvedValue("v1");
    mocks.refresh.mockReset();
    mocks.unregister.mockReset();
    mocks.reload.mockReset();
    mocks.inspectSources.mockReturnValue({
      bridges: Object.fromEntries(entries.map((entry) => [entry.server, entry])),
      sources: {
        native: Object.fromEntries(entries.map((entry) => [entry.server, entry])),
        legacy: {},
      },
    });
    mocks.status.mockResolvedValue([
      {
        policy: { present: true },
        provider: { present: true, attached: true, credentialReady: true },
      },
    ]);
    mocks.preflightTargets.mockResolvedValue(
      new Map(entries.map((entry) => [entry.server, { addresses: entry.allowedIps }])),
    );
    mocks.register.mockImplementation(
      (_sandbox: string, _adapter: string, entry: { server: string }) => {
        const fail =
          entry.server === "second"
            ? () => {
                throw new Error("post-write verification failed");
              }
            : () => undefined;
        fail();
      },
    );
  });

  it("removes an unauthorized restored adapter before reloading and rejecting", async () => {
    const events: string[] = [];
    const handle = `s${"a".repeat(64)}`;
    mocks.observe.mockResolvedValue(handle);
    mocks.wait.mockResolvedValue(handle);
    mocks.refresh.mockImplementation(() => {
      events.push("refresh");
    });
    mocks.status.mockImplementation(async () => {
      events.push("probe");
      return [
        {
          provider: {
            credentialResolution: {
              ok: null,
              httpStatus: 401,
              controlHttpStatus: 401,
              detail: "updated credential remained unauthorized",
            },
          },
        },
      ];
    });
    mocks.unregister.mockImplementation(async () => {
      events.push("unregister");
      await new Promise<void>((resolve) => setImmediate(resolve));
      events.push("removed");
      return "removed";
    });
    mocks.reload.mockImplementation(() => {
      events.push("reload");
    });

    await expect(restoreExistingMcpBridgeRuntime("alpha", [entries[0]])).rejects.toThrow(
      "did not authorize its unchanged stable credential handle after provider update",
    );
    expect(events).toEqual(["refresh", "probe", "unregister", "removed", "reload"]);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.status).toHaveBeenCalledWith("alpha", "first", {
      allowCredentialProbeWithAdapterMismatch: true,
      probeCredentialResolution: true,
      runtimeSelection: { gatewayName: "nemoclaw", workspace: "default" },
    });
  });

  it("reloads every attempted OpenClaw restart mutation before propagating failure", async () => {
    await expect(restartMcpBridge("alpha")).rejects.toThrow("post-write verification failed");

    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(mocks.reload).toHaveBeenCalledOnce();
    expect(mocks.reload).toHaveBeenCalledWith("alpha", ["openclaw-config", "openclaw-config"]);
  });

  it("reloads every attempted OpenClaw restoration mutation before propagating failure", async () => {
    await expect(restoreExistingMcpBridgeRuntime("alpha", entries)).rejects.toThrow(
      "post-write verification failed",
    );

    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(mocks.reload).toHaveBeenCalledOnce();
    expect(mocks.reload).toHaveBeenCalledWith("alpha", ["openclaw-config", "openclaw-config"]);
  });
});
