// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import type { McpProviderAttachment } from "./mcp-bridge-provider-inspection";

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
  inspectMcpProviderAttachments: vi.fn(),
  inspectSourceBridgeState: vi.fn(),
  inspectAgentMcpSources: vi.fn(),
  assertMcpProviderRecoverable: vi.fn(),
  assertNoProviderCredentialCollisions: vi.fn(),
  getPolicyPresence: vi.fn(),
  detachProvider: vi.fn(),
  waitForDetachedMcpCredential: vi.fn(),
  assertAgentMcpTeardownRuntimeCapability: vi.fn(),
  assertMcpAdapterTeardownRuntimeCapabilities: vi.fn(),
  observeMcpCredentialRevision: vi.fn(),
  removeGeneratedPolicy: vi.fn(),
  registerAgentAdapterAtCurrentCredentialRevision: vi.fn(),
  restoreExistingMcpBridgeRuntime: vi.fn(),
  unregisterAgentAdapter: vi.fn(),
}));

vi.mock("../../state/registry", () => ({ getSandbox: vi.fn(), updateSandbox: vi.fn() }));
vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withMcpLifecycleLock: vi.fn((_name: string, action: () => unknown) => action()),
}));
vi.mock("../../onboard/experimental/portable-agent-lifecycle", () => ({
  assertHermesPortableCommandUnavailable: vi.fn(),
}));
vi.mock("./mcp-bridge-adapters", () => ({
  assertAgentMcpTeardownRuntimeCapability: mocks.assertAgentMcpTeardownRuntimeCapability,
  registerAgentAdapterAtCurrentCredentialRevision:
    mocks.registerAgentAdapterAtCurrentCredentialRevision,
  unregisterAgentAdapter: mocks.unregisterAgentAdapter,
}));
vi.mock("./mcp-bridge-provider-readiness", () => ({
  observeMcpCredentialRevision: mocks.observeMcpCredentialRevision,
}));
vi.mock("./mcp-bridge-provider", async (importOriginal) => ({
  assertMcpProviderRecoverable: mocks.assertMcpProviderRecoverable,
  assertNoProviderCredentialCollisions: mocks.assertNoProviderCredentialCollisions,
  assertNoRegisteredProviderCredentialCollisions: vi.fn(),
  detachProvider: mocks.detachProvider,
  getMcpProviderInspectionRuntimeSelection: mocks.getMcpProviderInspectionRuntimeSelection,
  inspectMcpProvider: mocks.inspectMcpProvider,
  inspectMcpProviderAttachments: mocks.inspectMcpProviderAttachments,
  preflightMcpEntryTargets: vi.fn(),
  waitForDetachedMcpCredential: mocks.waitForDetachedMcpCredential,
  providerMatchesManagedCredential: (await importOriginal<typeof import("./mcp-bridge-provider")>())
    .providerMatchesManagedCredential,
}));
vi.mock("./mcp-bridge-source", () => ({
  inspectSourceBridgeState: mocks.inspectSourceBridgeState,
  inspectAgentMcpSources: mocks.inspectAgentMcpSources,
}));
vi.mock("./mcp-bridge-destroy-preflight", () => ({
  cloneMcpSourceEntry: vi.fn((candidate: McpSourceEntry) => ({
    ...candidate,
    env: [...candidate.env],
  })),
  inspectExactMcpDestroyProvider: mocks.inspectExactMcpDestroyProvider,
}));
vi.mock("./mcp-bridge-policy", async (importOriginal) => ({
  assertGeneratedPolicyMutationSafe: (await importOriginal<typeof import("./mcp-bridge-policy")>())
    .assertGeneratedPolicyMutationSafe,
  getPolicyPresence: mocks.getPolicyPresence,
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
  assertMcpAdapterTeardownRuntimeCapabilities: mocks.assertMcpAdapterTeardownRuntimeCapabilities,
}));
vi.mock("./mcp-bridge-state", () => ({
  ensureSandboxGatewaySelected: mocks.ensureSandboxGatewaySelected,
  getBridgeAdapter: mocks.getBridgeAdapter,
  getSandboxAgent: mocks.getSandboxAgent,
  getSandboxOrThrow: mocks.getSandboxOrThrow,
  resolveMcpOperationTarget: (name: string) => ({
    sandbox: mocks.getSandboxOrThrow(name),
    runtimeSelection: { gatewayName: "nemoclaw-8091", workspace: "default" },
  }),
}));
vi.mock("./mcp-bridge-validation", () => ({
  assertAuthenticatedBridgeEntry: vi.fn(),
  resolvePersistedCredentialEnvForRedaction: vi.fn(() => ({})),
  validateMcpServerName: vi.fn(),
  validateSandboxName: vi.fn(),
}));

import { scrubManagedMcpAdapterOrThrow } from "./mcp-bridge-adapter-teardown";
import { prepareMcpBridgesForRebuild } from "./mcp-bridge-rebuild";
import { removeMcpBridge } from "./mcp-bridge-remove";

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
    mocks.observeMcpCredentialRevision.mockReset().mockReturnValue("v12");
    mocks.removeGeneratedPolicy.mockReset().mockImplementation(() => {
      throw new Error("forced lifecycle failure after adapter scrub");
    });
    mocks.registerAgentAdapterAtCurrentCredentialRevision.mockReset();
    mocks.restoreExistingMcpBridgeRuntime.mockReset();
    mocks.unregisterAgentAdapter.mockReset().mockReturnValue("removed");
    mocks.assertMcpProviderRecoverable.mockReset();
    mocks.assertNoProviderCredentialCollisions.mockReset();
    mocks.inspectAgentMcpSources.mockReset();
    mocks.assertMcpAdapterTeardownRuntimeCapabilities.mockReset();
  });

  it("retains all enforcement guards when explicit legacy migration has no native adapter", async () => {
    const legacy = {
      ...entry,
      agent: "langchain-deepagents-code",
      adapter: "deepagents-config" as const,
      source: "legacy" as const,
    };
    const legacySandbox = { ...sandbox, name: "alpha", agent: legacy.agent };
    mocks.getSandboxOrThrow.mockReturnValue(legacySandbox);
    mocks.inspectAgentMcpSources.mockReturnValue({ native: {}, legacy: { github: legacy } });
    await expect(prepareMcpBridgesForRebuild("alpha", [legacy])).rejects.toThrow(
      "forced lifecycle failure after adapter scrub",
    );
    expect(mocks.assertMcpAdapterTeardownRuntimeCapabilities).toHaveBeenCalledWith(
      "alpha",
      legacySandbox,
      [legacy],
      runtimeSelection,
    );
    expect(mocks.assertMcpProviderRecoverable).toHaveBeenCalledWith(legacy, runtimeSelection);
    expect(mocks.assertNoProviderCredentialCollisions).toHaveBeenCalledWith(
      "alpha",
      [legacy],
      runtimeSelection,
    );
    expect(mocks.removeGeneratedPolicy).toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
  });

  it("scrubs and rolls back a native adapter that exists beside the explicit legacy source", async () => {
    const legacy = { ...entry, source: "legacy" as const };
    mocks.inspectAgentMcpSources.mockReturnValue({
      native: { github: { ...entry, source: "native" } },
      legacy: { github: legacy },
    });
    await expect(prepareMcpBridgesForRebuild("alpha", [legacy])).rejects.toThrow(
      "forced lifecycle failure after adapter scrub",
    );
    expect(mocks.unregisterAgentAdapter).toHaveBeenCalledOnce();
    expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).toHaveBeenCalledOnce();
  });

  it("refuses changed provider identity before any legacy migration teardown", async () => {
    const legacy = { ...entry, source: "legacy" as const };
    mocks.assertMcpProviderRecoverable.mockRejectedValueOnce(
      new Error("provider identity changed"),
    );
    await expect(prepareMcpBridgesForRebuild("alpha", [legacy])).rejects.toThrow(
      "provider identity changed",
    );
    expect(mocks.captureRecordedSandboxBasePolicy).not.toHaveBeenCalled();
    expect(mocks.inspectAgentMcpSources).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("restores the fresh revision observed after a later rebuild step fails (#10155)", async () => {
    mocks.observeMcpCredentialRevision
      .mockReset()
      .mockReturnValueOnce("v12")
      .mockReturnValueOnce("v13")
      .mockReturnValue("v13");

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

  it("does not derive a Hermes credential revision from a provider resource version", () => {
    mocks.observeMcpCredentialRevision.mockReturnValue("absent");
    mocks.inspectMcpProvider.mockReturnValue({
      credentialKeys: ["GITHUB_TOKEN"],
      exists: true,
      id: entry.providerId,
      resourceVersion: 12,
      type: "nemoclaw-mcp-v1",
    });

    expect(() => scrubManagedMcpAdapterOrThrow("alpha", sandbox, entry, runtimeSelection)).toThrow(
      "Could not prove a revision-scoped credential before removing the managed adapter entry for MCP server 'github'.",
    );
    expect(mocks.inspectMcpProvider).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).not.toHaveBeenCalled();
  });
});

describe("source-backed MCP removal recovery", () => {
  let native: Record<string, McpSourceEntry>;
  let policyPresent: boolean;
  let attachments: McpProviderAttachment[];
  const events: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    native = { github: entry };
    policyPresent = true;
    attachments = [
      { name: entry.providerName!, providerId: entry.providerId!, credentialKeys: [...entry.env] },
    ];
    events.length = 0;
    mocks.getSandboxOrThrow.mockReturnValue({ name: "alpha", agent: "hermes" });
    mocks.getSandboxAgent.mockReturnValue({ displayName: "Hermes" });
    mocks.getBridgeAdapter.mockReturnValue("hermes-config");
    mocks.getMcpProviderInspectionRuntimeSelection.mockReturnValue(runtimeSelection);
    mocks.ensureSandboxGatewaySelected.mockResolvedValue(undefined);
    mocks.assertAgentMcpTeardownRuntimeCapability.mockReset();
    mocks.inspectSourceBridgeState.mockReset().mockImplementation(async () => ({
      bridges: { ...native },
      sources: { native: { ...native }, legacy: {} },
    }));
    mocks.getPolicyPresence.mockReset().mockImplementation(() => policyPresent);
    mocks.inspectMcpProvider.mockReset().mockResolvedValue({
      exists: true,
      id: entry.providerId,
      type: "nemoclaw-mcp-v1",
      credentialKeys: ["GITHUB_TOKEN"],
    });
    mocks.inspectMcpProviderAttachments
      .mockReset()
      .mockImplementation(async () => ({ attachments: [...attachments] }));
    mocks.detachProvider.mockReset().mockImplementation(async () => {
      // OpenShell v0.0.106 validates the remaining attachments against current policy.
      await (policyPresent
        ? Promise.reject(
            new Error(
              "credential_binding references provider, but that provider is not attached to the sandbox",
            ),
          )
        : Promise.resolve());
      events.push("detach");
      attachments = [];
      return "detached";
    });
    mocks.waitForDetachedMcpCredential.mockReset().mockImplementation(() => {
      events.push("credential absent");
    });
    mocks.removeGeneratedPolicy.mockReset().mockImplementation(() => {
      events.push("policy removed");
      policyPresent = false;
    });
    mocks.unregisterAgentAdapter.mockReset().mockImplementation(() => {
      events.push("native removed");
      delete native.github;
      return "removed";
    });
  });

  it("retains the source after policy failure and completes an explicit retry", async () => {
    mocks.removeGeneratedPolicy.mockImplementationOnce(() => {
      throw new Error("policy unavailable");
    });
    await expect(removeMcpBridge("alpha", "github")).rejects.toThrow(/retained.*mcp remove github/);
    expect(native).toEqual({ github: entry });
    expect(events).toEqual([]);
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();

    await removeMcpBridge("alpha", "github");
    expect(native).toEqual({});
    expect(policyPresent).toBe(false);
    expect(events).toEqual(["policy removed", "detach", "credential absent", "native removed"]);
    expect(mocks.inspectMcpProviderAttachments).toHaveBeenCalledWith("alpha", runtimeSelection);
    expect(mocks.detachProvider.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.inspectMcpProviderAttachments.mock.invocationCallOrder[0],
    );
    expect(mocks.inspectMcpProviderAttachments.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.waitForDetachedMcpCredential.mock.invocationCallOrder[0],
    );
    expect(mocks.detachProvider).toHaveBeenLastCalledWith("alpha", entry, {
      allowLegacyGeneric: true,
      runtimeSelection,
    });
  });

  it.each([{}, { force: true }, { allowResidual: true }])(
    "preserves native authority after an unknown detach outcome with options %j",
    async (options) => {
      mocks.detachProvider.mockResolvedValueOnce("unknown");
      await expect(removeMcpBridge("alpha", "github", options)).rejects.toThrow(/retained/);
      expect(native).toEqual({ github: entry });
      expect(mocks.removeGeneratedPolicy).toHaveBeenCalledOnce();
      expect(policyPresent).toBe(false);
      expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    },
  );

  it("retains native source after policy removal when credential revocation is unproven", async () => {
    mocks.waitForDetachedMcpCredential.mockImplementationOnce(() => {
      throw new Error("fresh exec still has credential");
    });
    await expect(removeMcpBridge("alpha", "github", { force: true })).rejects.toThrow(/retained/);
    expect(native).toEqual({ github: entry });
    expect(mocks.removeGeneratedPolicy).toHaveBeenCalledOnce();
    expect(policyPresent).toBe(false);
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
  });

  it("retains the source on a thrown detach failure and redacts its credential detail", async () => {
    mocks.detachProvider.mockRejectedValueOnce(new Error("detach failed: Bearer private-secret"));
    const failure = removeMcpBridge("alpha", "github", { force: true });
    await expect(failure).rejects.toThrow(/retained.*mcp remove github/);
    await expect(failure).rejects.not.toThrow(/private-secret/);
    expect(native).toEqual({ github: entry });
    expect(mocks.removeGeneratedPolicy).toHaveBeenCalledOnce();
    expect(policyPresent).toBe(false);
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
  });

  it.each([
    { exists: null },
    {
      exists: true,
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      type: "nemoclaw-mcp-v1",
      credentialKeys: ["GITHUB_TOKEN"],
    },
  ])("preserves an unproven or replaced provider before cleanup: %j", async (provider) => {
    mocks.inspectMcpProvider.mockResolvedValueOnce(provider);
    await expect(removeMcpBridge("alpha", "github", { force: true })).rejects.toThrow(/retained/);
    expect(native).toEqual({ github: entry });
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
  });

  it.each(["alpha-mcp-github", "custom-mcp-provider"])(
    "finishes a native-removal retry without adopting an inferred provider after %s was detached",
    async (providerName) => {
      native.github = { ...entry, providerName };
      mocks.unregisterAgentAdapter.mockImplementationOnce(() => {
        throw new Error("native transaction unavailable");
      });
      await expect(removeMcpBridge("alpha", "github")).rejects.toThrow(/native transaction/);
      expect(native.github?.providerName).toBe(providerName);
      expect(policyPresent).toBe(false);
      expect(mocks.detachProvider).toHaveBeenCalledWith("alpha", native.github, {
        allowLegacyGeneric: true,
        runtimeSelection,
      });
      // The source join may report a new same-name provider once policy is absent.
      native.github = { ...entry, providerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
      mocks.inspectMcpProvider.mockClear();
      mocks.detachProvider.mockClear();
      mocks.removeGeneratedPolicy.mockClear();
      await removeMcpBridge("alpha", "github");
      expect(native).toEqual({});
      expect(mocks.inspectMcpProvider).not.toHaveBeenCalled();
      expect(mocks.detachProvider).not.toHaveBeenCalled();
      expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
      expect(mocks.waitForDetachedMcpCredential).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves an absent-policy source when its credential still exists", async () => {
    policyPresent = false;
    attachments = [];
    mocks.waitForDetachedMcpCredential.mockImplementationOnce(() => {
      throw new Error("credential remains");
    });
    await expect(
      removeMcpBridge("alpha", "github", { force: true, allowResidual: true }),
    ).rejects.toThrow(/retained/);
    expect(native).toEqual({ github: entry });
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
  });

  it.each([
    { providerName: "alpha-mcp-github", options: {} },
    { providerName: "custom-mcp-provider", options: { force: true } },
    { providerName: "foreign-provider-with-key", options: { allowResidual: true } },
  ])(
    "retains native source with withheld credentials until operator detaches $providerName",
    async ({ providerName, options }) => {
      policyPresent = false;
      attachments = [
        {
          name: providerName,
          providerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          credentialKeys: [...entry.env],
        },
      ];
      // Endpointless providers with no policy binding withhold credentials even while attached.
      // The source join may infer a different same-name provider; it is not detach authority.
      native.github = { ...entry, providerId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" };
      await expect(removeMcpBridge("alpha", "github", options)).rejects.toThrow(/retained/);
      expect(native.github).toMatchObject({
        ...entry,
        providerId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      });
      expect(mocks.inspectMcpProviderAttachments).toHaveBeenCalledWith("alpha", runtimeSelection);
      expect(mocks.inspectMcpProvider).not.toHaveBeenCalled();
      expect(mocks.detachProvider).not.toHaveBeenCalled();
      expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
      expect(mocks.waitForDetachedMcpCredential).not.toHaveBeenCalled();
      expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();

      attachments = []; // An independent operator completes the identified attachment cleanup.
      await removeMcpBridge("alpha", "github", options);
      expect(native).toEqual({});
      expect(mocks.detachProvider).not.toHaveBeenCalled();
      expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
      expect(mocks.waitForDetachedMcpCredential).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      state: "unavailable",
      read: () => ({ attachments: null, error: "attachment inventory unavailable" }),
    },
    {
      state: "failed",
      read: () => {
        throw new Error("attachment inventory unavailable");
      },
    },
  ])("retains an absent-policy source when attachment inventory is $state", async ({ read }) => {
    policyPresent = false;
    mocks.inspectMcpProviderAttachments.mockImplementationOnce(read);
    await expect(
      removeMcpBridge("alpha", "github", { force: true, allowResidual: true }),
    ).rejects.toThrow(/retained/);
    expect(native).toEqual({ github: entry });
    expect(mocks.inspectMcpProvider).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.waitForDetachedMcpCredential).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
  });

  it("retains native source when a credential-bearing attachment remains after reported detach success", async () => {
    mocks.detachProvider.mockResolvedValueOnce("detached");
    await expect(removeMcpBridge("alpha", "github")).rejects.toThrow(/retained/);
    expect(policyPresent).toBe(false);
    expect(native).toEqual({ github: entry });
    expect(mocks.inspectMcpProviderAttachments).toHaveBeenCalledWith("alpha", runtimeSelection);
    expect(mocks.waitForDetachedMcpCredential).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
  });

  it("rejects a conflicting policy before any mutation even with force", async () => {
    native.github = { ...entry, policyConflict: "native URL differs from live endpoint" };
    await expect(removeMcpBridge("alpha", "github", { force: true })).rejects.toThrow(
      /conflicting live policy/,
    );
    expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
  });

  it("retains the source when live policy presence cannot be established", async () => {
    mocks.getPolicyPresence.mockReturnValueOnce(null);
    await expect(removeMcpBridge("alpha", "github")).rejects.toThrow(/policy/);
    expect(native).toEqual({ github: entry });
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
  });

  it("keeps the explicit native force override after exact cleanup succeeds", async () => {
    await removeMcpBridge("alpha", "github", { force: true });
    expect(events).toEqual(["policy removed", "detach", "credential absent", "native removed"]);
    expect(mocks.unregisterAgentAdapter).toHaveBeenCalledWith(
      "alpha",
      "hermes-config",
      entry,
      runtimeSelection,
      { force: true, envValues: {}, teardown: true },
    );
    expect(native).toEqual({});
    expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).not.toHaveBeenCalled();
  });

  it("requires credential absence before removing a native entry whose provider is absent", async () => {
    mocks.inspectMcpProvider.mockResolvedValueOnce({ exists: false });
    attachments = [];
    await removeMcpBridge("alpha", "github");
    expect(events).toEqual(["policy removed", "credential absent", "native removed"]);
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    expect(native).toEqual({});
  });

  it("does not infer cleanup authority for policy-only or provider-only state with force", async () => {
    native = {};
    await removeMcpBridge("alpha", "github", { force: true });
    expect(mocks.getPolicyPresence).not.toHaveBeenCalled();
    expect(mocks.inspectMcpProvider).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
  });
});
