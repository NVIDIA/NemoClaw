// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  assertMcpDestroyNotPending: vi.fn(),
  bridgeState: vi.fn(),
  discardSafeIncompleteMcpAdds: vi.fn(),
  ensureSandboxGatewaySelected: vi.fn(),
  getBridgeAdapter: vi.fn(),
  getSandboxAgent: vi.fn(),
  getSandboxOrThrow: vi.fn(),
  inspectMcpProvider: vi.fn(),
  observeMcpCredentialRevision: vi.fn(),
  removeGeneratedPolicy: vi.fn(),
  registerAgentAdapterAtCurrentCredentialRevision: vi.fn(),
  restoreExistingMcpBridgeRuntime: vi.fn(),
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
  inspectMcpProvider: mocks.inspectMcpProvider,
  preflightMcpEntryTargets: vi.fn(),
  waitForDetachedMcpCredential: vi.fn(),
}));

vi.mock("./mcp-bridge-destroy-preflight", () => ({
  cloneMcpBridgeEntry: vi.fn((entry: McpBridgeEntry) => ({ ...entry, env: [...entry.env] })),
  discardSafeIncompleteMcpAdds: mocks.discardSafeIncompleteMcpAdds,
  inspectExactMcpDestroyProvider: vi.fn(),
}));

vi.mock("./mcp-bridge-policy", () => ({
  assertGeneratedPolicyMutationSafe: vi.fn(),
  assertGeneratedPolicyRegistrationMutationSafe: vi.fn(),
  removeGeneratedPolicy: mocks.removeGeneratedPolicy,
}));

vi.mock("./mcp-bridge-restart", () => ({
  restoreExistingMcpBridgeRuntime: mocks.restoreExistingMcpBridgeRuntime,
}));

vi.mock("./mcp-bridge-runtime-capabilities", () => ({
  assertMcpAdapterConfigMutationsAllowed: vi.fn(),
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
  setBridgeState: vi.fn(),
}));

vi.mock("./mcp-bridge-validation", () => ({
  assertAuthenticatedBridgeEntry: vi.fn(),
  validateSandboxName: vi.fn(),
}));

import { prepareMcpBridgesForDestroy } from "./mcp-bridge-destroy";
import { prepareMcpBridgesForRebuild } from "./mcp-bridge-rebuild";
import { scrubManagedMcpAdapterOrThrow } from "./mcp-bridge-adapter-teardown";

const sandbox = { agent: "hermes" } as SandboxEntry;
const entry: McpBridgeEntry = {
  server: "github",
  agent: "hermes",
  adapter: "hermes-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

describe("MCP adapter teardown rollback", () => {
  beforeEach(() => {
    mocks.bridgeState.mockReset().mockReturnValue({ github: entry });
    mocks.discardSafeIncompleteMcpAdds.mockReset().mockResolvedValue(sandbox);
    mocks.ensureSandboxGatewaySelected.mockReset().mockResolvedValue(undefined);
    mocks.getBridgeAdapter.mockReset().mockReturnValue("hermes-config");
    mocks.getSandboxAgent.mockReset().mockReturnValue("hermes");
    mocks.getSandboxOrThrow.mockReset().mockReturnValue(sandbox);
    mocks.inspectMcpProvider.mockReset().mockReturnValue({ exists: false });
    mocks.observeMcpCredentialRevision.mockReset().mockReturnValue("v12");
    mocks.removeGeneratedPolicy.mockReset().mockImplementation(() => {
      throw new Error("forced lifecycle failure after adapter scrub");
    });
    mocks.registerAgentAdapterAtCurrentCredentialRevision.mockReset();
    mocks.restoreExistingMcpBridgeRuntime.mockReset();
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

    expect(() => scrubManagedMcpAdapterOrThrow("alpha", sandbox, entry)).toThrow(
      "Could not prove a revision-scoped credential before removing the managed adapter entry for MCP server 'github'.",
    );
    expect(mocks.inspectMcpProvider).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).not.toHaveBeenCalled();
  });
});
