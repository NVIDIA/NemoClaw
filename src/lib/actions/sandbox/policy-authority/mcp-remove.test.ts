// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../../state/registry";

const harness = vi.hoisted(() => ({
  actions: [] as string[],
  afterAdapterRemoval: undefined as (() => void) | undefined,
  afterQualification: undefined as (() => void) | undefined,
  afterRegistryRemoval: undefined as (() => void) | undefined,
  authority: "externally-managed" as "nemoclaw-managed" | "externally-managed",
  buildRequiredPolicy: vi.fn(() => "required external MCP policy"),
  detachProvider: vi.fn(),
  policyRemove: vi.fn(),
  qualifyAuthority: vi.fn(),
  revalidateAuthority: vi.fn(),
  sandbox: undefined as SandboxEntry | undefined,
}));

vi.mock("../../../state/mcp-lifecycle-lock", () => ({
  withMcpLifecycleLock: async (_sandboxName: string, operation: () => Promise<void>) => operation(),
}));

vi.mock("../../../onboard/experimental/portable-agent-lifecycle", () => ({
  assertHermesPortableCommandUnavailable: vi.fn(),
}));

vi.mock("../mcp-bridge-adapters", () => ({
  assertAgentMcpConfigMutationAllowed: vi.fn(),
  assertAgentMcpTeardownRuntimeCapability: vi.fn(),
  unregisterAgentAdapter: vi.fn(() => {
    harness.actions.push("adapter:remove");
    harness.afterAdapterRemoval?.();
    return "removed";
  }),
}));

vi.mock("../mcp-bridge-hermes-reconciliation", () => ({
  assertHermesMcpRuntimeIntent: vi.fn(),
}));

vi.mock("../mcp-bridge-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp-bridge-policy")>();
  harness.qualifyAuthority.mockImplementation((options) => {
    const receipt = { ...options, authority: harness.authority };
    harness.afterQualification?.();
    return receipt;
  });
  harness.revalidateAuthority.mockImplementation(
    async (
      receipt: { authority: typeof harness.authority },
      _validateContainingReceipt: undefined,
      assertCurrentState?: () => void,
    ) => {
      (receipt.authority === harness.authority
        ? () => undefined
        : () => {
            throw new actual.McpPolicyAuthorityRefusalError("policy authority changed");
          })();
      assertCurrentState?.();
    },
  );
  return {
    ...actual,
    buildRequiredMcpBridgePolicy: harness.buildRequiredPolicy,
    qualifyMcpPolicyAuthorityReceipt: harness.qualifyAuthority,
    removeGeneratedPolicy: harness.policyRemove,
    revalidateMcpPolicyAuthorityReceipt: harness.revalidateAuthority,
  };
});

vi.mock("../mcp-bridge-provider", () => ({
  deleteProvider: vi.fn(() => harness.actions.push("provider:delete")),
  detachMissingProviderReference: vi.fn(() => "detached"),
  detachProvider: harness.detachProvider,
  inspectMcpProvider: vi.fn(() => ({
    credentialKeys: ["MCP_TOKEN"],
    exists: true,
    id: "11111111-2222-4333-8444-555555555555",
    resourceVersion: "1",
    type: "nemoclaw-mcp-v1",
  })),
  preflightMcpEntryTargets: vi.fn(async () => new Map([["example", { addresses: ["8.8.8.8"] }]])),
  providerMatchesManagedCredential: vi.fn(() => true),
  providerShapeDetail: vi.fn(() => null),
  waitForDetachedMcpCredential: vi.fn(),
}));

vi.mock("../mcp-bridge-state", () => ({
  assertMcpDestroyNotPending: vi.fn(),
  bridgeState: (sandbox: SandboxEntry) => sandbox.mcp?.bridges ?? {},
  clearMcpDestroyMarkers: vi.fn(() => false),
  ensureSandboxGatewaySelected: vi.fn(async () => {
    harness.actions.push("gateway:select");
  }),
  getBridgeAdapter: vi.fn(() => "mcporter"),
  getSandboxAgent: vi.fn(() => ({ name: "openclaw" })),
  getSandboxOrThrow: vi.fn(() => harness.sandbox),
  removeBridgeEntry: vi.fn((_sandboxName: string, server: string) => {
    harness.actions.push("registry:remove");
    delete harness.sandbox?.mcp?.bridges[server];
    harness.afterRegistryRemoval?.();
  }),
}));

vi.mock("../mcp-bridge-validation", () => ({
  assertAuthenticatedBridgeEntry: vi.fn(),
  assertPersistedAuthenticatedBridgeEntry: vi.fn(),
  resolvePersistedCredentialEnvForRedaction: vi.fn(() => ({})),
  validateMcpServerName: vi.fn(),
  validateSandboxName: vi.fn(),
}));

import { removeMcpBridge } from "../mcp-bridge-remove";
import { McpPolicyAuthorityRefusalError } from "../mcp-bridge-policy";

const entry = {
  server: "example",
  agent: "openclaw",
  adapter: "mcporter" as const,
  url: "https://mcp.example.test/mcp",
  env: ["MCP_TOKEN"],
  providerName: "alpha-mcp-example-1234567890abcdef",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-example",
  addedAt: "2026-08-24T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  harness.actions.length = 0;
  harness.afterAdapterRemoval = undefined;
  harness.afterQualification = undefined;
  harness.afterRegistryRemoval = undefined;
  harness.authority = "externally-managed";
  harness.sandbox = {
    name: "alpha",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    policyAuthority: harness.authority,
    mcp: { bridges: { example: { ...entry, env: [...entry.env] } } },
  };
  harness.detachProvider.mockImplementation(async (_sandboxName, _entry, options) => {
    await options.prepareMutation?.();
    harness.actions.push("provider:detach");
    return "detached";
  });
});

describe("standalone MCP remove policy authority", () => {
  it("removes external runtime state without policy mutation or attribution (#9833)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await removeMcpBridge("alpha", "example");

    expect(harness.qualifyAuthority).toHaveBeenNthCalledWith(2, {
      operation: "remove MCP server 'example'",
      requiredPolicyContents: ["required external MCP policy"],
      sandboxName: "alpha",
    });
    expect(harness.qualifyAuthority).toHaveBeenCalledTimes(2);
    expect(harness.actions).toEqual([
      "gateway:select",
      "adapter:remove",
      "provider:detach",
      "provider:delete",
      "registry:remove",
    ]);
    expect(harness.policyRemove).not.toHaveBeenCalled();
    expect(harness.sandbox?.customPolicies).toBeUndefined();
    expect(harness.sandbox?.mcp?.bridges).toEqual({});
    expect(harness.revalidateAuthority).toHaveBeenCalledTimes(6);
    expect(log).toHaveBeenCalledWith("  Removed MCP server 'example' from sandbox 'alpha'.");
  });

  it("refuses managed-to-external drift before the first mutation under force (#9833)", async () => {
    harness.authority = "nemoclaw-managed";
    harness.sandbox = { ...harness.sandbox!, policyAuthority: "nemoclaw-managed" };
    harness.afterQualification = () => {
      harness.authority = "externally-managed";
    };

    await expect(
      removeMcpBridge("alpha", "example", { allowResidual: true, force: true }),
    ).rejects.toBeInstanceOf(McpPolicyAuthorityRefusalError);

    expect(harness.actions).toEqual([]);
    expect(harness.policyRemove).not.toHaveBeenCalled();
    expect(harness.sandbox?.mcp?.bridges.example).toEqual(expect.objectContaining(entry));
  });

  it("stops after adapter cleanup when managed authority changes under force (#9833)", async () => {
    harness.authority = "nemoclaw-managed";
    harness.sandbox = { ...harness.sandbox!, policyAuthority: "nemoclaw-managed" };
    harness.afterAdapterRemoval = () => {
      harness.authority = "externally-managed";
    };

    await expect(
      removeMcpBridge("alpha", "example", { allowResidual: true, force: true }),
    ).rejects.toBeInstanceOf(McpPolicyAuthorityRefusalError);

    expect(harness.actions).toEqual(["gateway:select", "adapter:remove"]);
    expect(harness.policyRemove).not.toHaveBeenCalled();
    expect(harness.detachProvider).not.toHaveBeenCalled();
    expect(harness.sandbox?.mcp?.bridges.example).toEqual(expect.objectContaining(entry));
  });

  it("withholds removal success when the bridge manifest changes during removal (#9833)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    harness.afterRegistryRemoval = () => {
      harness.sandbox!.mcp!.bridges.concurrent = {
        ...entry,
        server: "concurrent",
      };
    };

    await expect(removeMcpBridge("alpha", "example")).rejects.toThrow(
      "MCP bridge definitions changed while server removal was in progress",
    );

    expect(harness.actions).toEqual([
      "gateway:select",
      "adapter:remove",
      "provider:detach",
      "provider:delete",
      "registry:remove",
    ]);
    expect(log).not.toHaveBeenCalledWith("  Removed MCP server 'example' from sandbox 'alpha'.");
  });
});
