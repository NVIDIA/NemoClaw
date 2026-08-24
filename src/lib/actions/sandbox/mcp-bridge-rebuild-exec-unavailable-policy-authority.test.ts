// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { isPolicyAuthorityRefusalError } from "../../adapters/openshell/policy-authority";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";

const harness = vi.hoisted(() => ({
  assertAuthenticatedBridgeEntry: vi.fn(),
  assertDestroyNotPending: vi.fn(),
  assertDestroySnapshotCurrent: vi.fn(),
  assertGeneratedPolicyExactReadOnly: vi.fn(),
  assertNoProviderCredentialCollisions: vi.fn(),
  bridgeState: vi.fn(),
  buildRequiredPolicy: vi.fn(),
  ensureSandboxGatewaySelected: vi.fn(),
  getBridgeAdapter: vi.fn(),
  getSandboxAgent: vi.fn(),
  getSandboxOrThrow: vi.fn(),
  inspectExactDestroyProvider: vi.fn(),
  preflightEntryTargets: vi.fn(),
  qualifyAuthority: vi.fn(),
  resolveSandboxGatewayName: vi.fn(),
  revalidateAuthority: vi.fn(),
  validateSandboxName: vi.fn(),
}));

vi.mock("../../onboard/gateway-binding", () => ({
  resolveSandboxGatewayName: harness.resolveSandboxGatewayName,
}));

vi.mock("./mcp-bridge-destroy-preflight", () => ({
  assertMcpDestroySnapshotCurrent: harness.assertDestroySnapshotCurrent,
  cloneMcpBridgeEntry: (entry: McpBridgeEntry) => structuredClone(entry),
  inspectExactMcpDestroyProvider: harness.inspectExactDestroyProvider,
}));

vi.mock("./mcp-bridge-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-bridge-policy")>();
  return {
    assertGeneratedPolicyExactReadOnly: harness.assertGeneratedPolicyExactReadOnly,
    buildRequiredMcpBridgePolicy: harness.buildRequiredPolicy,
    McpPolicyAuthorityRefusalError: actual.McpPolicyAuthorityRefusalError,
    qualifyMcpPolicyAuthorityReceipt: harness.qualifyAuthority,
    revalidateContainingMcpPolicyAuthority: actual.revalidateContainingMcpPolicyAuthority,
    revalidateMcpPolicyAuthorityReceipt: harness.revalidateAuthority,
  };
});

vi.mock("./mcp-bridge-provider", () => ({
  assertNoProviderCredentialCollisions: harness.assertNoProviderCredentialCollisions,
  preflightMcpEntryTargets: harness.preflightEntryTargets,
}));

vi.mock("./mcp-bridge-state", () => ({
  assertMcpDestroyNotPending: harness.assertDestroyNotPending,
  bridgeState: harness.bridgeState,
  ensureSandboxGatewaySelected: harness.ensureSandboxGatewaySelected,
  getBridgeAdapter: harness.getBridgeAdapter,
  getSandboxAgent: harness.getSandboxAgent,
  getSandboxOrThrow: harness.getSandboxOrThrow,
}));

vi.mock("./mcp-bridge-validation", () => ({
  assertAuthenticatedBridgeEntry: harness.assertAuthenticatedBridgeEntry,
  validateSandboxName: harness.validateSandboxName,
}));

const { prepareMcpBridgesForExecUnavailableRebuild } =
  await import("./mcp-bridge-rebuild-exec-unavailable");
const { McpPolicyAuthorityRefusalError } = await import("./mcp-bridge-policy");

const entry: McpBridgeEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://mcp.example.test/server",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
  addedAt: "2026-08-24T00:00:00.000Z",
};

const sandbox: SandboxEntry = {
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  policyAuthority: "externally-managed",
  mcp: { bridges: { github: entry } },
};

describe("exec-unavailable MCP rebuild policy authority", () => {
  let authority: "externally-managed" | "nemoclaw-managed";
  let providerResourceVersion: number;
  let targetAddress: string;

  beforeEach(() => {
    vi.clearAllMocks();
    authority = "externally-managed";
    providerResourceVersion = 1;
    targetAddress = "8.8.8.8";
    harness.getSandboxOrThrow.mockReturnValue(sandbox);
    harness.bridgeState.mockImplementation((current: SandboxEntry) => current.mcp?.bridges ?? {});
    harness.getSandboxAgent.mockReturnValue({ name: "openclaw" });
    harness.getBridgeAdapter.mockReturnValue("mcporter");
    harness.resolveSandboxGatewayName.mockReturnValue("nemoclaw");
    harness.assertDestroySnapshotCurrent.mockReturnValue(sandbox);
    harness.preflightEntryTargets.mockImplementation(
      async () => new Map([[entry.server, { addresses: [targetAddress] }]]),
    );
    harness.buildRequiredPolicy.mockImplementation(
      (_entry: McpBridgeEntry, target: { addresses: readonly string[] }) =>
        `required:${target.addresses.join(",")}`,
    );
    harness.qualifyAuthority.mockImplementation(
      (options: {
        operation: string;
        requiredPolicyContents: readonly string[];
        sandboxName: string;
      }) => ({ ...options, authority }),
    );
    harness.revalidateAuthority.mockImplementation(
      async (
        _receipt: unknown,
        validateContainingReceipt?: () => Promise<void>,
        assertCurrentState?: () => void,
      ) => {
        await validateContainingReceipt?.();
        assertCurrentState?.();
      },
    );
    harness.assertGeneratedPolicyExactReadOnly.mockReturnValue({
      name: entry.policyName,
      content: "managed policy",
      sourcePath: "generated:nemoclaw-mcp-bridge",
    });
    harness.inspectExactDestroyProvider.mockImplementation(() => ({
      exists: true,
      id: entry.providerId,
      resourceVersion: providerResourceVersion,
      type: "nemoclaw-mcp-v1",
      credentialKeys: entry.env,
    }));
  });

  it("accepts exact external policy without NemoClaw attribution (#9833)", async () => {
    const validateContainingPolicyReceipt = vi.fn(async () => undefined);

    const preparation = await prepareMcpBridgesForExecUnavailableRebuild(
      "alpha",
      validateContainingPolicyReceipt,
    );
    await expect(preparation.revalidateBeforeDelete()).resolves.toBeUndefined();

    expect(harness.qualifyAuthority).toHaveBeenCalledWith({
      operation: "preserve MCP bridges during host-side rebuild recovery for sandbox 'alpha'",
      requiredPolicyContents: ["required:8.8.8.8"],
      sandboxName: "alpha",
    });
    expect(harness.assertGeneratedPolicyExactReadOnly).not.toHaveBeenCalled();
    expect(sandbox.customPolicies).toBeUndefined();
    expect(preparation.entries).toEqual([entry]);
    expect(validateContainingPolicyReceipt).toHaveBeenCalled();
  });

  it.each(["missing", "inconclusive"])(
    "preserves canonical refusal when the external requirement is %s (#9833)",
    async (state) => {
      harness.qualifyAuthority.mockImplementationOnce(() => {
        throw new McpPolicyAuthorityRefusalError(`external policy requirement is ${state}`);
      });

      let refusal: unknown;
      try {
        await prepareMcpBridgesForExecUnavailableRebuild("alpha");
      } catch (error) {
        refusal = error;
      }

      expect(isPolicyAuthorityRefusalError(refusal)).toBe(true);
      expect(refusal).toEqual(expect.objectContaining({ message: expect.stringContaining(state) }));
      expect(harness.inspectExactDestroyProvider).not.toHaveBeenCalled();
      expect(harness.assertGeneratedPolicyExactReadOnly).not.toHaveBeenCalled();
    },
  );

  it("refuses external policy drift during delete-edge revalidation (#9833)", async () => {
    const preparation = await prepareMcpBridgesForExecUnavailableRebuild("alpha");
    harness.revalidateAuthority.mockRejectedValueOnce(
      new McpPolicyAuthorityRefusalError("external policy requirement drifted"),
    );

    await expect(preparation.revalidateBeforeDelete()).rejects.toSatisfy(
      isPolicyAuthorityRefusalError,
    );
  });

  it("refuses target drift before host-side delete (#9833)", async () => {
    const preparation = await prepareMcpBridgesForExecUnavailableRebuild("alpha");
    targetAddress = "9.9.9.9";

    await expect(preparation.revalidateBeforeDelete()).rejects.toThrow(
      "changed after host-side rebuild preflight",
    );
  });

  it("refuses provider drift before host-side delete (#9833)", async () => {
    const preparation = await prepareMcpBridgesForExecUnavailableRebuild("alpha");
    providerResourceVersion = 2;

    await expect(preparation.revalidateBeforeDelete()).rejects.toThrow(
      "changed after host-side rebuild preflight",
    );
  });

  it("refuses manifest drift before host-side delete (#9833)", async () => {
    const preparation = await prepareMcpBridgesForExecUnavailableRebuild("alpha");
    harness.assertDestroySnapshotCurrent.mockImplementationOnce(() => {
      throw new Error("MCP bridge definitions changed");
    });

    await expect(preparation.revalidateBeforeDelete()).rejects.toThrow(
      "MCP bridge definitions changed",
    );
  });

  it("retains generated ownership proof for managed authority (#9833)", async () => {
    authority = "nemoclaw-managed";
    const managedSandbox = { ...sandbox, policyAuthority: authority };
    harness.getSandboxOrThrow.mockReturnValue(managedSandbox);
    harness.assertDestroySnapshotCurrent.mockReturnValue(managedSandbox);

    const preparation = await prepareMcpBridgesForExecUnavailableRebuild("alpha");
    await expect(preparation.revalidateBeforeDelete()).resolves.toBeUndefined();

    expect(harness.assertGeneratedPolicyExactReadOnly).toHaveBeenCalled();
  });

  it("refuses managed recovery without exact generated ownership (#9833)", async () => {
    authority = "nemoclaw-managed";
    const managedSandbox = { ...sandbox, policyAuthority: authority };
    harness.getSandboxOrThrow.mockReturnValue(managedSandbox);
    harness.assertDestroySnapshotCurrent.mockReturnValue(managedSandbox);
    harness.assertGeneratedPolicyExactReadOnly.mockImplementationOnce(() => {
      throw new Error("generated policy ownership is missing");
    });

    await expect(prepareMcpBridgesForExecUnavailableRebuild("alpha")).rejects.toThrow(
      "generated policy ownership is missing",
    );
  });
});
