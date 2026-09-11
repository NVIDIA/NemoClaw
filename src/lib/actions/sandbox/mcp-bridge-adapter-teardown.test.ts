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
  assertMcpProviderRecoverable: vi.fn(),
  assertNoProviderCredentialCollisions: vi.fn(),
  assertNoRegisteredProviderCredentialCollisions: vi.fn(),
  detachProvider: vi.fn(),
  getMcpProviderInspectionRuntimeSelection: mocks.getMcpProviderInspectionRuntimeSelection,
  inspectMcpProvider: mocks.inspectMcpProvider,
  preflightMcpEntryTargets: vi.fn(),
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
  assertMcpAdapterTeardownRuntimeCapabilities: vi.fn(),
}));
vi.mock("./mcp-bridge-state", () => ({
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
import { prepareMcpBridgesForRebuild } from "./mcp-bridge-rebuild";

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
    mocks.observeMcpCredentialRevision.mockReset().mockResolvedValue("v12");
    mocks.removeGeneratedPolicy.mockReset().mockImplementation(() => {
      throw new Error("forced lifecycle failure after adapter scrub");
    });
    mocks.registerAgentAdapterAtCurrentCredentialRevision.mockReset().mockResolvedValue("v12");
    mocks.restoreExistingMcpBridgeRuntime.mockReset();
    mocks.unregisterAgentAdapter.mockReset().mockReturnValue("removed");
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
