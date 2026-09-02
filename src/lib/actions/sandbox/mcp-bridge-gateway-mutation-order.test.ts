// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  applyGeneratedPolicy: vi.fn(),
  attachProvider: vi.fn(),
  ensureSandboxGatewaySelected: vi.fn(),
  registerAgentAdapter: vi.fn(),
  registerAgentAdapterAtCurrentCredentialRevision: vi.fn(),
  upsertMcpProvider: vi.fn(),
  writeBridgeEntry: vi.fn(),
}));

const entry: McpBridgeEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://api.github.com/mcp/",
  env: ["GITHUB_TOKEN"],
  allowedIps: ["8.8.8.8", "8.8.4.4"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
  addedAt: "2026-09-01T00:00:00.000Z",
};
const sandbox = {
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  mcp: { bridges: { github: entry } },
} as SandboxEntry;

vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withMcpLifecycleLock: (_sandboxName: string, action: () => unknown) => action(),
}));
vi.mock("../../state/mcp-lifecycle-lock/credential-ownership", () => ({
  withMcpCredentialOwnershipLock: (action: () => unknown) => action(),
}));
vi.mock("../../state/registry", () => ({}));
vi.mock("../../security/trusted-private-endpoint", () => ({
  normalizeTrustedPrivateHost: (host: string) => host,
  parseTrustedPrivateHosts: () => [],
  replayTrustedPrivateEndpoint: vi.fn(),
}));
vi.mock("../../onboard/experimental/portable-agent-lifecycle", () => ({
  assertHermesPortableCommandUnavailable: vi.fn(),
}));
vi.mock("./mcp-bridge-adapters", () => ({
  assertAgentMcpConfigMutationAllowed: vi.fn(),
  assertAgentMcpMutationRuntimeCapability: vi.fn(),
  inspectAgentAdapterRegistration: vi.fn(() => ({ state: "absent" })),
  registerAgentAdapter: mocks.registerAgentAdapter,
  registerAgentAdapterAtCurrentCredentialRevision:
    mocks.registerAgentAdapterAtCurrentCredentialRevision,
  unregisterAgentAdapter: vi.fn(),
}));
vi.mock("./mcp-bridge-hermes-reconciliation", () => ({
  assertHermesMcpRuntimeIntent: vi.fn(),
}));
vi.mock("./mcp-bridge-policy", () => ({
  applyGeneratedPolicy: mocks.applyGeneratedPolicy,
  assertGeneratedPolicyMutationSafe: vi.fn(),
  buildMcpBridgePolicyKey: vi.fn(() => "mcp_bridge_github"),
  buildMcpBridgePolicyName: vi.fn(() => "mcp-bridge-github"),
  buildMcpBridgePolicyYaml: vi.fn(() => "version: 1\nnetwork_policies: {}\n"),
  removeGeneratedPolicy: vi.fn(),
}));
vi.mock("./mcp-bridge-provider", () => ({
  assertMcpProviderRecoverable: vi.fn(() => ({ exists: true, id: entry.providerId })),
  assertNoAttachedProviderCredentialCollisions: vi.fn(),
  assertNoProviderCredentialCollisions: vi.fn(),
  attachProvider: mocks.attachProvider,
  deleteProvider: vi.fn(),
  detachMissingProviderReference: vi.fn(),
  detachProvider: vi.fn(),
  ensureMcpBridgeProviderProfile: vi.fn(),
  inspectMcpProvider: vi.fn(() => ({ exists: false })),
  observeMcpCredentialRevision: vi.fn(),
  preflightMcpEntryTargets: vi.fn(
    async (entries: readonly McpBridgeEntry[]) =>
      new Map(entries.map((candidate) => [candidate.server, { addresses: ["8.8.8.8"] }])),
  ),
  providerMatchesCredential: vi.fn(),
  providerShapeDetail: vi.fn(),
  refreshMcpProviderEnvironment: vi.fn(),
  upsertMcpProvider: mocks.upsertMcpProvider,
  waitForAttachedMcpCredential: vi.fn(() => "v1"),
  waitForDetachedMcpCredential: vi.fn(),
}));
vi.mock("./mcp-bridge-runtime-capabilities", () => ({
  assertMcpAdapterConfigMutationsAllowed: vi.fn(),
  assertMcpAdapterMutationRuntimeCapabilities: vi.fn(),
  assertMcpAdapterTeardownRuntimeCapabilities: vi.fn(),
}));
vi.mock("./mcp-bridge-state", () => ({
  assertMcpDestroyNotPending: vi.fn(),
  assertNoDerivedResourceCollision: vi.fn(),
  bridgeState: vi.fn((candidate: SandboxEntry) => candidate.mcp?.bridges ?? {}),
  ensureSandboxGatewaySelected: mocks.ensureSandboxGatewaySelected,
  getBridgeAdapter: vi.fn(() => "mcporter"),
  getSandboxAgent: vi.fn(() => ({ name: "openclaw" })),
  getSandboxOrThrow: vi.fn(() => sandbox),
  nowIso: vi.fn(() => "2026-09-01T00:00:00.000Z"),
  writeBridgeEntry: mocks.writeBridgeEntry,
}));
vi.mock("./mcp-bridge-validation", () => ({
  assertAuthenticatedBridgeEntry: vi.fn(),
  assertAuthenticatedCredentialReference: vi.fn(),
  assertMcpCredentialBoundaryRuntimeVersion: vi.fn(),
  buildMcpBridgeProviderName: vi.fn(() => "alpha-mcp-github"),
  normalizeMcpServerUrl: vi.fn((url: string) => url),
  preflightMcpServerUrlResolvedTarget: vi.fn(async () => ({
    addresses: ["8.8.8.8", "8.8.4.4"],
  })),
  resolveCredentialEnv: vi.fn((refs: Array<{ name: string }>) =>
    Object.fromEntries(refs.map(({ name }) => [name, "test-only-value"])),
  ),
  uniqueEnvNames: vi.fn((refs: Array<{ name: string }>) => refs.map(({ name }) => name)),
  validateMcpServerName: vi.fn(),
  validateSandboxName: vi.fn(),
}));

import { addMcpBridge } from "./mcp-bridge-add-restart";
import { restartMcpBridge, restoreExistingMcpBridgeRuntime } from "./mcp-bridge-restart";

describe("managed MCP proxy DNS mutation ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureSandboxGatewaySelected.mockRejectedValue(
      new Error("unsafe proxy hostname resolution"),
    );
  });

  it.each([
    [
      "add",
      () =>
        addMcpBridge("alpha", {
          server: "new-server",
          url: "https://api.example.com/mcp/",
          env: [{ name: "NEW_TOKEN" }],
        }),
    ],
    ["restart", () => restartMcpBridge("alpha", "github")],
    ["rebuild restoration", () => restoreExistingMcpBridgeRuntime("alpha", [entry])],
  ] as const)(
    "stops %s before policy, provider, registry, or adapter mutation",
    async (_name, run) => {
      await expect(run()).rejects.toThrow("unsafe proxy hostname resolution");

      expect(mocks.ensureSandboxGatewaySelected).toHaveBeenCalledWith("alpha", {
        requireMcpProxyDnsDisabled: true,
      });
      expect(mocks.applyGeneratedPolicy).not.toHaveBeenCalled();
      expect(mocks.upsertMcpProvider).not.toHaveBeenCalled();
      expect(mocks.attachProvider).not.toHaveBeenCalled();
      expect(mocks.writeBridgeEntry).not.toHaveBeenCalled();
      expect(mocks.registerAgentAdapter).not.toHaveBeenCalled();
      expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).not.toHaveBeenCalled();
    },
  );
});
