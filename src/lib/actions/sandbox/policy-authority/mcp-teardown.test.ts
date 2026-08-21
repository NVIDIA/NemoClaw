// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const originalHome = process.env.HOME;
  const stateHome = `/tmp/nemoclaw-mcp-teardown-authority-${process.pid}`;
  process.env.HOME = stateHome;
  return {
    actions: [] as string[],
    adapterRegistered: true,
    authority: "nemoclaw-managed" as "nemoclaw-managed" | "externally-managed",
    detachOutcomes: [] as Array<"detached" | "unknown">,
    originalHome,
    policyRemoved: false,
    preflightAuthority: vi.fn(),
    providerAttached: true,
    stateHome,
  };
});

vi.mock("../../../policy", () => ({
  applyPresetContent: vi.fn(() => {
    harness.actions.push("policy:restore");
    harness.policyRemoved = false;
    return true;
  }),
  getLiveSandboxPolicyEntryDigest: vi.fn(() => (harness.policyRemoved ? null : "present")),
  getPresetContentGatewayState: vi.fn(() => (harness.policyRemoved ? "absent" : "match")),
  removePreset: vi.fn(() => {
    harness.actions.push("policy:remove");
    harness.policyRemoved = true;
    return true;
  }),
}));

vi.mock("./preflight", () => ({
  preflightSandboxPolicyAuthority: harness.preflightAuthority,
}));

vi.mock("../mcp-bridge-adapter-teardown", () => ({
  rollbackScrubbedMcpAdapters: vi.fn(() => {
    harness.actions.push("adapter:rollback");
    harness.adapterRegistered = true;
    return [];
  }),
  scrubManagedMcpAdapterOrThrow: vi.fn(() => {
    harness.actions.push("adapter:scrub");
    harness.adapterRegistered = false;
  }),
}));

vi.mock("../mcp-bridge-adapters", () => ({
  registerAgentAdapter: vi.fn(() => {
    harness.actions.push("adapter:rollback");
    harness.adapterRegistered = true;
  }),
}));

vi.mock("../mcp-bridge-provider", () => ({
  assertMcpProviderRecoverable: vi.fn(() => ({ exists: true })),
  assertNoAttachedProviderCredentialCollisions: vi.fn(),
  assertNoProviderCredentialCollisions: vi.fn(),
  assertNoRegisteredProviderCredentialCollisions: vi.fn(),
  attachProvider: vi.fn(() => {
    harness.actions.push("provider:attach");
    harness.providerAttached = true;
  }),
  deleteProvider: vi.fn(),
  detachMissingProviderReference: vi.fn(),
  detachProvider: vi.fn(() => {
    const outcome = harness.detachOutcomes.shift() ?? "detached";
    harness.actions.push("provider:detach");
    harness.providerAttached = outcome === "detached" ? false : harness.providerAttached;
    return outcome;
  }),
  inspectMcpProvider: vi.fn(() => ({
    credentialKeys: ["MCP_TOKEN"],
    exists: true,
    id: "11111111-2222-4333-8444-555555555555",
    resourceVersion: "1",
    type: "nemoclaw-mcp-v1",
  })),
  ensureMcpBridgeProviderProfile: vi.fn(),
  observeMcpCredentialRevision: vi.fn(),
  preflightMcpEntryTargets: vi.fn(
    async (entries: Array<{ server: string }>) =>
      new Map(entries.map((entry) => [entry.server, { addresses: ["8.8.8.8"] }])),
  ),
  providerMatchesManagedCredential: vi.fn(() => true),
  refreshMcpProviderEnvironment: vi.fn(),
  upsertMcpProvider: vi.fn(),
  waitForAttachedMcpCredential: vi.fn(),
  waitForDetachedMcpCredential: vi.fn(),
}));

vi.mock("../mcp-bridge-runtime-capabilities", () => ({
  assertMcpAdapterConfigMutationsAllowed: vi.fn(),
  assertMcpAdapterMutationRuntimeCapabilities: vi.fn(),
  assertMcpAdapterTeardownRuntimeCapabilities: vi.fn(),
}));

vi.mock("../mcp-bridge-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp-bridge-state")>()),
  ensureSandboxGatewaySelected: vi.fn(async () => undefined),
}));

import * as registry from "../../../state/registry";
import {
  prepareMcpBridgesForDestroy,
  restoreMcpBridgesAfterDestroyAbort,
} from "../mcp-bridge-destroy";
import { assertMcpProviderRecoverable } from "../mcp-bridge-provider";
import {
  McpPolicyAuthorityRefusalError,
  qualifyMcpPolicyAuthorityReceipt,
  revalidateMcpPolicyAuthorityReceipt,
} from "../mcp-bridge-policy";
import { buildMcpBridgePolicyYaml } from "../mcp-bridge-policy-render";
import { prepareMcpBridgesForRebuild } from "../mcp-bridge-rebuild";

const bridgeEntry = {
  server: "example",
  agent: "openclaw",
  adapter: "mcporter" as const,
  url: "https://mcp.example.test/mcp",
  env: ["MCP_TOKEN"],
  providerName: "alpha-mcp-example",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-example",
  addedAt: "2026-08-20T00:00:00.000Z",
};

function registerSandbox(authority: "nemoclaw-managed" | "externally-managed"): void {
  registry.registerSandbox({
    name: "alpha",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    policyAuthority: authority,
    mcp: { bridges: { example: bridgeEntry } },
  });
  authority === "nemoclaw-managed" &&
    registry.addCustomPolicy("alpha", {
      name: bridgeEntry.policyName,
      content: buildMcpBridgePolicyYaml(
        bridgeEntry.server,
        bridgeEntry.url,
        bridgeEntry.adapter,
        { addresses: ["8.8.8.8"] },
        bridgeEntry.providerName,
      ),
      sourcePath: "generated:nemoclaw-mcp-bridge",
    });
}

beforeEach(() => {
  fs.rmSync(harness.stateHome, { recursive: true, force: true });
  harness.actions.length = 0;
  harness.adapterRegistered = true;
  harness.authority = "nemoclaw-managed";
  harness.detachOutcomes.length = 0;
  harness.policyRemoved = false;
  harness.providerAttached = true;
  harness.preflightAuthority.mockReset();
  harness.preflightAuthority.mockImplementation(() => harness.authority);
});

afterAll(() => {
  fs.rmSync(harness.stateHome, { recursive: true, force: true });
  process.env.HOME = harness.originalHome;
});

describe("MCP teardown policy authority", () => {
  it.each([
    ["destroy", prepareMcpBridgesForDestroy],
    ["rebuild", prepareMcpBridgesForRebuild],
  ] as const)(
    "preserves externally managed policy during %s preparation (#9833)",
    async (_operation, prepare) => {
      harness.authority = "externally-managed";
      registerSandbox("externally-managed");

      await prepare("alpha");

      expect(harness.actions).toEqual(["adapter:scrub", "provider:detach"]);
      expect(registry.getCustomPolicies("alpha")).toEqual([]);
      expect(harness.preflightAuthority).toHaveBeenCalledTimes(1);
    },
  );

  it("restores a prepared destroy before propagating a containing authority refusal (#9833)", async () => {
    harness.authority = "externally-managed";
    registerSandbox("externally-managed");
    const preparation = await prepareMcpBridgesForDestroy("alpha");
    harness.actions.length = 0;
    const validateContainingReceipt = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new McpPolicyAuthorityRefusalError("destroy policy authority changed"),
      );

    await expect(
      restoreMcpBridgesAfterDestroyAbort("alpha", preparation, validateContainingReceipt),
    ).rejects.toBeInstanceOf(McpPolicyAuthorityRefusalError);

    expect(harness.actions).toEqual(["provider:attach", "adapter:rollback"]);
    expect(harness.actions).not.toContain("policy:restore");
    expect(harness.adapterRegistered).toBe(true);
    expect(harness.providerAttached).toBe(true);
    expect(registry.getSandbox("alpha")?.mcp?.destroyPreparedAt).toBeUndefined();
  });

  it("retains the prepared destroy marker when authority refusal compensation fails (#9833)", async () => {
    harness.authority = "externally-managed";
    registerSandbox("externally-managed");
    const preparation = await prepareMcpBridgesForDestroy("alpha");
    vi.mocked(assertMcpProviderRecoverable).mockImplementationOnce(() => {
      throw new Error("provider recovery failed");
    });

    await expect(
      restoreMcpBridgesAfterDestroyAbort("alpha", preparation, async () => {
        throw new McpPolicyAuthorityRefusalError("destroy policy authority changed");
      }),
    ).rejects.toBeInstanceOf(McpPolicyAuthorityRefusalError);

    expect(registry.getSandbox("alpha")?.mcp?.destroyPreparedAt).toEqual(expect.any(String));
    expect(registry.getSandbox("alpha")?.mcp?.bridges.example).toEqual(bridgeEntry);
  });

  it.each([
    ["destroy", prepareMcpBridgesForDestroy],
    ["rebuild", prepareMcpBridgesForRebuild],
  ] as const)(
    "compensates %s after authority drift follows the first owned mutation (#9833)",
    async (_operation, prepare) => {
      registerSandbox("nemoclaw-managed");
      const validateContainingReceipt = vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(async () => {
          harness.authority = "externally-managed";
          throw new Error("policy authority changed after adapter cleanup");
        });

      await expect(prepare("alpha", validateContainingReceipt)).rejects.toBeInstanceOf(
        McpPolicyAuthorityRefusalError,
      );

      expect(harness.actions).toEqual(["adapter:scrub", "provider:attach", "adapter:rollback"]);
      expect(harness.actions).not.toContain("policy:restore");
      expect(harness.preflightAuthority).toHaveBeenCalledTimes(2);
      expect(harness.adapterRegistered).toBe(true);
      expect(harness.providerAttached).toBe(true);
      expect(registry.getSandbox("alpha")?.mcp?.bridges.example).toEqual(
        expect.objectContaining(bridgeEntry),
      );
    },
  );

  it("restores external MCP runtime after provider detach cannot be proved (#9833)", async () => {
    harness.authority = "externally-managed";
    harness.detachOutcomes.push("unknown");
    registerSandbox("externally-managed");

    await expect(prepareMcpBridgesForDestroy("alpha")).rejects.toThrow(
      "Could not prove provider detach",
    );

    expect(harness.actions).toEqual([
      "adapter:scrub",
      "provider:detach",
      "provider:attach",
      "adapter:rollback",
    ]);
    expect(harness.actions).not.toContain("policy:remove");
  });

  it.each([
    ["destroy", prepareMcpBridgesForDestroy],
    ["rebuild", prepareMcpBridgesForRebuild],
  ] as const)(
    "restores MCP runtime after %s detach failure without consulting a stale containing receipt (#9833)",
    async (_operation, prepare) => {
      harness.authority = "externally-managed";
      harness.detachOutcomes.push("unknown");
      registerSandbox("externally-managed");
      const validateContainingReceipt = vi
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error("containing policy authority changed"));

      await expect(prepare("alpha", validateContainingReceipt)).rejects.toThrow(
        "Could not prove provider detach",
      );

      expect(validateContainingReceipt).not.toHaveBeenCalled();
      expect(harness.actions).toEqual([
        "adapter:scrub",
        "provider:detach",
        "provider:attach",
        "adapter:rollback",
      ]);
      expect(harness.adapterRegistered).toBe(true);
      expect(harness.providerAttached).toBe(true);
    },
  );

  it("does not roll back after the original MCP bridge snapshot changes (#9833)", async () => {
    registerSandbox("nemoclaw-managed");
    const validateContainingReceipt = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        registry.updateSandbox("alpha", {
          mcp: {
            bridges: {
              example: { ...bridgeEntry, url: "https://changed.example.test/mcp" },
            },
          },
        });
      });

    await expect(
      prepareMcpBridgesForRebuild("alpha", validateContainingReceipt),
    ).rejects.toBeInstanceOf(McpPolicyAuthorityRefusalError);

    expect(harness.actions).toEqual(["adapter:scrub"]);
    expect(harness.adapterRegistered).toBe(false);
  });

  it("rejects a policy authority that differs from the qualified receipt (#9833)", async () => {
    const receipt = qualifyMcpPolicyAuthorityReceipt({
      operation: "prepare MCP teardown",
      requiredPolicyContents: ["network_policies: {}\n"],
      sandboxName: "alpha",
    });
    harness.authority = "externally-managed";

    await expect(revalidateMcpPolicyAuthorityReceipt(receipt)).rejects.toBeInstanceOf(
      McpPolicyAuthorityRefusalError,
    );
  });
});
