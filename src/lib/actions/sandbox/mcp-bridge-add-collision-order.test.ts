// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyGeneratedPolicy: vi.fn(),
  assertNoProviderCredentialCollisions: vi.fn(),
  bridgeState: vi.fn(() => ({})),
  deleteProvider: vi.fn(),
  detachProvider: vi.fn(() => "absent"),
  inspectAgentAdapterRegistration: vi.fn(),
  inspectMcpProvider: vi.fn(),
  providerMatchesCredential: vi.fn(),
  removeGeneratedPolicy: vi.fn(),
  scrubManagedMcpAdapterOrThrow: vi.fn(),
  upsertMcpProvider: vi.fn(),
  writeBridgeEntry: vi.fn(),
}));

vi.mock("../../policy", () => ({
  getPresetContentGatewayState: vi.fn(() => "absent"),
}));

vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withMcpLifecycleLock: vi.fn((_sandboxName: string, work: () => Promise<void>) => work()),
}));

vi.mock("../../state/registry", () => ({
  getCustomPolicies: vi.fn(() => []),
  listExtraProviders: vi.fn(() => []),
}));

vi.mock("./mcp-bridge-adapters", () => ({
  assertAgentMcpConfigMutationAllowed: vi.fn(),
  assertAgentMcpMutationRuntimeCapability: vi.fn(),
  inspectAgentAdapterRegistration: mocks.inspectAgentAdapterRegistration,
  registerAgentAdapter: vi.fn(),
  unregisterAgentAdapter: vi.fn(),
}));

vi.mock("./mcp-bridge-adapter-teardown", () => ({
  rollbackScrubbedMcpAdapters: vi.fn(() => []),
  scrubManagedMcpAdapterOrThrow: mocks.scrubManagedMcpAdapterOrThrow,
}));

vi.mock("./mcp-bridge-destroy", () => ({
  cloneMcpBridgeEntry: vi.fn((entry) => ({ ...entry })),
  discardSafeIncompleteMcpAdds: vi.fn(async (_sandboxName, sandbox) => sandbox),
  inspectExactMcpDestroyProvider: vi.fn(),
}));

vi.mock("./mcp-bridge-hermes-reconciliation", () => ({
  assertHermesMcpRuntimeIntent: vi.fn(),
}));

vi.mock("./mcp-bridge-policy", () => ({
  applyGeneratedPolicy: mocks.applyGeneratedPolicy,
  assertGeneratedPolicyMutationSafe: vi.fn(),
  assertGeneratedPolicyRegistrationMutationSafe: vi.fn(),
  buildMcpBridgePolicyKey: vi.fn(() => "mcp:example"),
  buildMcpBridgePolicyName: vi.fn(() => "mcp-bridge-example"),
  buildMcpBridgePolicyYaml: vi.fn(() => "policy"),
  removeGeneratedPolicy: mocks.removeGeneratedPolicy,
}));

vi.mock("./mcp-bridge-provider", () => ({
  assertMcpProviderRecoverable: vi.fn(),
  assertNoProviderCredentialCollisions: mocks.assertNoProviderCredentialCollisions,
  attachProvider: vi.fn(),
  deleteProvider: mocks.deleteProvider,
  detachMissingProviderReference: vi.fn(),
  detachProvider: mocks.detachProvider,
  inspectMcpProvider: mocks.inspectMcpProvider,
  observeMcpCredentialRevision: vi.fn(),
  providerMatchesCredential: mocks.providerMatchesCredential,
  providerShapeDetail: vi.fn(),
  preflightMcpEntryTargets: vi.fn(async () => new Map()),
  upsertMcpProvider: mocks.upsertMcpProvider,
  waitForAttachedMcpCredential: vi.fn(),
  waitForDetachedMcpCredential: vi.fn(),
}));

vi.mock("./mcp-bridge-runtime-capabilities", () => ({
  assertMcpAdapterConfigMutationsAllowed: vi.fn(),
  assertMcpAdapterTeardownRuntimeCapabilities: vi.fn(),
}));

vi.mock("./mcp-bridge-state", () => ({
  assertMcpDestroyNotPending: vi.fn(),
  assertNoDerivedResourceCollision: vi.fn(),
  bridgeState: mocks.bridgeState,
  ensureSandboxGatewaySelected: vi.fn(),
  getBridgeAdapter: vi.fn(() => "mcporter"),
  getSandboxAgent: vi.fn(() => ({ name: "openclaw" })),
  getSandboxOrThrow: vi.fn(() => ({ agent: "openclaw", name: "alpha" })),
  nowIso: vi.fn(() => "2026-08-17T00:00:00.000Z"),
  writeBridgeEntry: mocks.writeBridgeEntry,
}));

vi.mock("./mcp-bridge-validation", () => ({
  assertAuthenticatedCredentialReference: vi.fn(),
  assertMcpCredentialBoundaryRuntimeVersion: vi.fn(),
  buildMcpBridgeProviderName: vi.fn(() => "alpha-mcp-example"),
  normalizeMcpServerUrl: vi.fn((url: string) => url),
  normalizeTrustedPrivateHost: vi.fn((host: string) => host),
  parseTrustedPrivateHosts: vi.fn(() => []),
  preflightMcpServerUrlResolvedTarget: vi.fn(async () => ({ addresses: ["8.8.8.8"] })),
  resolveCredentialEnv: vi.fn(() => ({ EXAMPLE_TOKEN: "secret" })),
  uniqueEnvNames: vi.fn(() => ["EXAMPLE_TOKEN"]),
  validateMcpServerName: vi.fn(),
  validateSandboxName: vi.fn(),
}));

import { addMcpBridge } from "./mcp-bridge-add-restart";
import { prepareMcpBridgesForRebuild } from "./mcp-bridge-rebuild";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bridgeState.mockReturnValue({});
  mocks.inspectAgentAdapterRegistration.mockReturnValue({ state: "absent" });
  mocks.inspectMcpProvider.mockReturnValueOnce({ exists: false, id: null }).mockReturnValue({
    credentialKeys: ["EXAMPLE_TOKEN"],
    exists: true,
    id: "11111111-2222-4333-8444-555555555555",
    resourceVersion: "1",
    type: "generic",
  });
  mocks.providerMatchesCredential.mockReturnValue(true);
  mocks.upsertMcpProvider.mockReturnValue({
    action: "created",
    inspection: {
      credentialKeys: ["EXAMPLE_TOKEN"],
      exists: true,
      id: "11111111-2222-4333-8444-555555555555",
      resourceVersion: "1",
      type: "generic",
    },
  });
  mocks.assertNoProviderCredentialCollisions
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      throw new Error("late attached-provider collision");
    });
});

describe("MCP add attached-provider collision ordering", () => {
  it("rejects a provider collision before recording or mutating managed MCP state (#9388)", async () => {
    mocks.assertNoProviderCredentialCollisions.mockReset().mockImplementation(() => {
      throw new Error("registered provider collision");
    });

    await expect(
      addMcpBridge("alpha", {
        server: "example",
        url: "https://8.8.8.8/mcp",
        env: [{ name: "EXAMPLE_TOKEN" }],
      }),
    ).rejects.toThrow("registered provider collision");

    expect(mocks.writeBridgeEntry).not.toHaveBeenCalled();
    expect(mocks.applyGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.upsertMcpProvider).not.toHaveBeenCalled();
  });

  it("rejects a provider collision before rebuild teardown begins (#9388)", async () => {
    const entry = {
      server: "example",
      agent: "openclaw",
      adapter: "mcporter",
      url: "https://8.8.8.8/mcp",
      env: ["EXAMPLE_TOKEN"],
      providerName: "alpha-mcp-example",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-example",
      addedAt: "2026-08-17T00:00:00.000Z",
    };
    mocks.bridgeState.mockReturnValue({ example: entry });
    mocks.assertNoProviderCredentialCollisions.mockReset().mockImplementation(() => {
      throw new Error("registered provider collision");
    });

    await expect(prepareMcpBridgesForRebuild("alpha")).rejects.toThrow(
      "registered provider collision",
    );

    expect(mocks.scrubManagedMcpAdapterOrThrow).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("records ownership before the post-create collision scan", async () => {
    await expect(
      addMcpBridge("alpha", {
        server: "example",
        url: "https://8.8.8.8/mcp",
        env: [{ name: "EXAMPLE_TOKEN" }],
      }),
    ).rejects.toThrow("late attached-provider collision");

    const collisionCalls = mocks.assertNoProviderCredentialCollisions.mock.invocationCallOrder;
    const manifestWrites = mocks.writeBridgeEntry.mock.invocationCallOrder;
    expect(collisionCalls).toHaveLength(3);
    expect(manifestWrites).toHaveLength(3);
    expect(collisionCalls[0]).toBeLessThan(manifestWrites[0]);
    expect(mocks.upsertMcpProvider).toHaveBeenCalledOnce();
    expect(manifestWrites[2]).toBeLessThan(collisionCalls[2]);
  });
});
