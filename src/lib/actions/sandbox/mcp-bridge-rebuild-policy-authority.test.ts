// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyAuthorityRefusalError } from "../../adapters/openshell/policy-authority";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  assertAdapterConfigMutationsAllowed: vi.fn(),
  assertAdapterTeardownRuntimeCapabilities: vi.fn(),
  assertDestroyNotPending: vi.fn(),
  assertDestroySnapshotCurrent: vi.fn(),
  assertGeneratedPolicyMutationSafe: vi.fn(),
  assertNoProviderCredentialCollisions: vi.fn(),
  assertProviderRecoverable: vi.fn(),
  attachProvider: vi.fn(),
  bridgeState: vi.fn(),
  detachProvider: vi.fn(),
  discardSafeIncompleteAdds: vi.fn(),
  ensureSandboxGatewaySelected: vi.fn(),
  getSandboxOrThrow: vi.fn(),
  inspectExactDestroyProvider: vi.fn(),
  preflightEntryTargets: vi.fn(),
  removeGeneratedPolicy: vi.fn(),
  refreshProviderEnvironment: vi.fn(),
  restoreRuntime: vi.fn(),
  rollbackScrubbedAdapters: vi.fn(),
  scrubAdapter: vi.fn(),
  setBridgeState: vi.fn(),
  waitForDetachedCredential: vi.fn(),
  waitForAttachedCredential: vi.fn(),
}));

vi.mock("./mcp-bridge-adapter-teardown", () => ({
  rollbackScrubbedMcpAdapters: mocks.rollbackScrubbedAdapters,
  scrubManagedMcpAdapterOrThrow: mocks.scrubAdapter,
}));

vi.mock("./mcp-bridge-destroy", () => ({
  assertMcpDestroySnapshotCurrent: mocks.assertDestroySnapshotCurrent,
  cloneMcpBridgeEntry: (entry: McpBridgeEntry) => structuredClone(entry),
  discardSafeIncompleteMcpAdds: mocks.discardSafeIncompleteAdds,
  inspectExactMcpDestroyProvider: mocks.inspectExactDestroyProvider,
}));

vi.mock("./mcp-bridge-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-bridge-policy")>();
  return {
    assertGeneratedPolicyMutationSafe: mocks.assertGeneratedPolicyMutationSafe,
    assertGeneratedPolicyRegistrationMutationSafe: vi.fn(),
    buildRequiredMcpBridgePolicy: vi.fn(() => "required policy"),
    McpPolicyAuthorityRefusalError: actual.McpPolicyAuthorityRefusalError,
    qualifyMcpPolicyAuthorityReceipt: (options: {
      operation: string;
      requiredPolicyContents: readonly string[];
      sandboxName: string;
    }) => ({ ...options, authority: "externally-managed" as const }),
    removeGeneratedPolicy: mocks.removeGeneratedPolicy,
    revalidateContainingMcpPolicyAuthority: actual.revalidateContainingMcpPolicyAuthority,
    revalidateMcpPolicyAuthorityReceipt: async (
      _receipt: unknown,
      validateContainingReceipt?: () => Promise<void>,
      assertCurrentState?: () => void,
    ) => {
      await actual.revalidateContainingMcpPolicyAuthority(validateContainingReceipt);
      assertCurrentState?.();
    },
  };
});

vi.mock("./mcp-bridge-provider", () => ({
  assertMcpProviderRecoverable: mocks.assertProviderRecoverable,
  assertNoProviderCredentialCollisions: mocks.assertNoProviderCredentialCollisions,
  assertNoRegisteredProviderCredentialCollisions: vi.fn(),
  attachProvider: mocks.attachProvider,
  detachProvider: mocks.detachProvider,
  preflightMcpEntryTargets: mocks.preflightEntryTargets,
  refreshMcpProviderEnvironment: mocks.refreshProviderEnvironment,
  waitForAttachedMcpCredential: mocks.waitForAttachedCredential,
  waitForDetachedMcpCredential: mocks.waitForDetachedCredential,
}));

vi.mock("./mcp-bridge-restart", () => ({
  restoreExistingMcpBridgeRuntime: mocks.restoreRuntime,
}));

vi.mock("./mcp-bridge-runtime-capabilities", () => ({
  assertMcpAdapterConfigMutationsAllowed: mocks.assertAdapterConfigMutationsAllowed,
  assertMcpAdapterTeardownRuntimeCapabilities: mocks.assertAdapterTeardownRuntimeCapabilities,
}));

vi.mock("./mcp-bridge-state", () => ({
  assertMcpDestroyNotPending: mocks.assertDestroyNotPending,
  bridgeState: mocks.bridgeState,
  ensureSandboxGatewaySelected: mocks.ensureSandboxGatewaySelected,
  getSandboxOrThrow: mocks.getSandboxOrThrow,
  setBridgeState: mocks.setBridgeState,
}));

const { prepareMcpBridgesForRebuild, restoreMcpBridgesAfterRebuild } =
  await import("./mcp-bridge-rebuild");
const { McpPolicyAuthorityRefusalError } = await import("./mcp-bridge-policy");

let entry: McpBridgeEntry;
let sandbox: SandboxEntry;

describe("MCP rebuild policy authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    entry = {
      server: "github",
      agent: "openclaw",
      adapter: "mcporter",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github",
      providerId: "provider-1",
      policyName: "mcp-bridge-github",
      addedAt: "2026-08-20T00:00:00.000Z",
    };
    sandbox = {
      name: "alpha",
      agent: "openclaw",
      policyAuthority: "externally-managed",
      mcp: { bridges: { github: entry } },
    };
    mocks.getSandboxOrThrow.mockReturnValue(sandbox);
    mocks.bridgeState.mockImplementation((current: SandboxEntry) => current.mcp?.bridges ?? {});
    mocks.discardSafeIncompleteAdds.mockResolvedValue(sandbox);
    mocks.detachProvider.mockReturnValue("detached");
    mocks.preflightEntryTargets.mockImplementation(async (entries: readonly McpBridgeEntry[]) =>
      new Map(entries.map((current) => [current.server, { addresses: ["8.8.8.8"] }])),
    );
    mocks.rollbackScrubbedAdapters.mockReturnValue([]);
    mocks.assertDestroySnapshotCurrent.mockReturnValue(sandbox);
    mocks.scrubAdapter.mockImplementation((_name, _sandbox, current: McpBridgeEntry) => ({
      ...current,
      credentialRevision: "v1",
    }));
  });

  it("preserves externally managed policy while preparing adapter and provider state (#9833)", async () => {
    const validatePolicyAuthority = vi.fn().mockResolvedValue(undefined);

    await expect(
      prepareMcpBridgesForRebuild("alpha", validatePolicyAuthority),
    ).resolves.toMatchObject({
      entries: [entry],
      detachedProviderEntries: [entry],
      scrubbedAdapterEntries: [entry],
    });

    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(validatePolicyAuthority).toHaveBeenCalledTimes(3);
    expect(validatePolicyAuthority.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.scrubAdapter.mock.invocationCallOrder[0],
    );
    expect(validatePolicyAuthority.mock.invocationCallOrder[2]).toBeLessThan(
      mocks.detachProvider.mock.invocationCallOrder[0],
    );
  });

  it("reports a containing authority refusal before MCP teardown mutation (#9833)", async () => {
    const refusal = new PolicyAuthorityRefusalError("policy authority changed");
    const validatePolicyAuthority = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(refusal);

    await expect(prepareMcpBridgesForRebuild("alpha", validatePolicyAuthority)).rejects.toEqual(
      expect.objectContaining({
        message: refusal.message,
        name: McpPolicyAuthorityRefusalError.name,
      }),
    );

    expect(mocks.scrubAdapter).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("rolls back an adapter scrub when authority changes before policy removal (#9833)", async () => {
    sandbox.policyAuthority = "nemoclaw-managed";
    const refusal = new PolicyAuthorityRefusalError("policy authority changed");
    const validatePolicyAuthority = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(refusal);

    await expect(prepareMcpBridgesForRebuild("alpha", validatePolicyAuthority)).rejects.toEqual(
      expect.objectContaining({
        message: refusal.message,
        name: McpPolicyAuthorityRefusalError.name,
      }),
    );

    expect(mocks.restoreRuntime).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      [expect.objectContaining({ server: "github", credentialRevision: "v1" })],
      expect.objectContaining({
        lifecyclePhase: "teardown-rollback",
        teardownPolicyAuthorityRefusal: expect.objectContaining({ message: refusal.message }),
      }),
    );
    expect(mocks.rollbackScrubbedAdapters).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("reattaches a detached provider when authority changes before the next detach (#9833)", async () => {
    const second = {
      ...entry,
      server: "gitlab",
      env: ["GITLAB_TOKEN"],
      providerName: "alpha-mcp-gitlab",
      providerId: "provider-2",
      policyName: "mcp-bridge-gitlab",
    };
    sandbox.mcp = { bridges: { github: entry, gitlab: second } };
    const refusal = new PolicyAuthorityRefusalError("policy authority changed");
    const validatePolicyAuthority = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(refusal);

    await expect(prepareMcpBridgesForRebuild("alpha", validatePolicyAuthority)).rejects.toEqual(
      expect.objectContaining({
        message: refusal.message,
        name: McpPolicyAuthorityRefusalError.name,
      }),
    );

    expect(mocks.restoreRuntime).toHaveBeenCalledWith(
      "alpha",
      expect.arrayContaining([
        expect.objectContaining({ server: "github", credentialRevision: "v1" }),
        expect.objectContaining({ server: "gitlab", credentialRevision: "v1" }),
      ]),
      expect.objectContaining({
        lifecyclePhase: "teardown-rollback",
        teardownPolicyAuthorityRefusal: expect.objectContaining({ message: refusal.message }),
      }),
    );
    expect(mocks.attachProvider).not.toHaveBeenCalled();
    expect(mocks.rollbackScrubbedAdapters).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
  });

  it("revalidates between registry recovery and runtime restoration (#9833)", async () => {
    const refusal = new PolicyAuthorityRefusalError("policy authority changed");
    const validatePolicyAuthority = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(refusal);

    await expect(
      restoreMcpBridgesAfterRebuild("alpha", [entry], validatePolicyAuthority),
    ).rejects.toEqual(
      expect.objectContaining({
        message: refusal.message,
        name: McpPolicyAuthorityRefusalError.name,
      }),
    );

    expect(mocks.setBridgeState).toHaveBeenCalledOnce();
    expect(mocks.restoreRuntime).not.toHaveBeenCalled();
  });

  it("revalidates after MCP runtime restoration before returning success (#9833)", async () => {
    const validatePolicyAuthority = vi.fn().mockResolvedValue(undefined);

    await expect(
      restoreMcpBridgesAfterRebuild("alpha", [entry], validatePolicyAuthority),
    ).resolves.toBeUndefined();

    expect(validatePolicyAuthority).toHaveBeenCalledTimes(3);
    expect(mocks.restoreRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      validatePolicyAuthority.mock.invocationCallOrder[2],
    );
  });
});
