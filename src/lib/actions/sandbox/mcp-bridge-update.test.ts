// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns/promises";

import type { McpSourceEntry } from "./mcp-bridge-contracts";

const mocks = vi.hoisted(() => ({
  applyGeneratedPolicy: vi.fn().mockResolvedValue(undefined),
  assertGeneratedPolicyMutationSafe: vi.fn(),
  ensureSandboxGatewaySelected: vi.fn().mockResolvedValue(undefined),
  preflightMcpEntryTargets: vi
    .fn()
    .mockResolvedValue(new Map([["github", { addresses: ["8.8.8.8"] }]])),
  removeGeneratedPolicy: vi.fn().mockResolvedValue(undefined),
  inspectSourceBridgeState: vi.fn(),
  inspectAgentMcpSources: vi.fn(),
  refreshMcpPublicPolicyPins: vi.fn().mockResolvedValue(undefined),
  assertMcpProviderRecoverable: vi.fn().mockResolvedValue({ exists: true }),
}));

vi.mock("../../onboard/experimental/portable-agent-lifecycle", () => ({
  assertHermesPortableCommandUnavailable: vi.fn(),
}));
vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withMcpLifecycleLock: vi.fn((_sandboxName: string, action: () => unknown) => action()),
}));
vi.mock("./mcp-bridge-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-policy")>()),
  applyGeneratedPolicy: mocks.applyGeneratedPolicy,
  assertGeneratedPolicyMutationSafe: mocks.assertGeneratedPolicyMutationSafe,
  removeGeneratedPolicy: mocks.removeGeneratedPolicy,
  refreshMcpPublicPolicyPins: mocks.refreshMcpPublicPolicyPins,
}));
vi.mock("./mcp-bridge-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-provider")>()),
  assertMcpProviderRecoverable: mocks.assertMcpProviderRecoverable,
  getMcpProviderInspectionRuntimeSelection: vi.fn(() => ({
    gatewayName: "nemoclaw-9090",
    workspace: "default",
  })),
  preflightMcpEntryTargets: mocks.preflightMcpEntryTargets,
}));
vi.mock("./mcp-bridge-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-state")>()),
  ensureSandboxGatewaySelected: mocks.ensureSandboxGatewaySelected,
  getSandboxOrThrow: vi.fn(() => ({ name: "alpha", agent: "openclaw" })),
}));
vi.mock("./mcp-bridge-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-source")>()),
  inspectSourceBridgeState: mocks.inspectSourceBridgeState,
  inspectAgentMcpSources: mocks.inspectAgentMcpSources,
}));
vi.mock("./mcp-bridge-validation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-validation")>()),
  assertMcpCredentialBoundaryRuntimeVersion: vi.fn(),
}));

import {
  clearMcpBridgeAllowTools,
  refreshMcpBridgePublicPins,
  updateMcpBridgeAllowTools,
  updateMcpBridgeDenyTools,
} from "./mcp-bridge-add-restart";
import { assertMcpBridgePolicyTarget } from "./mcp-bridge-policy";
import { replayTrustedPrivateEndpoint } from "../../security/trusted-private-endpoint";
import { dispatchMcpBridgeCommand } from "./mcp-bridge";

const entry: McpSourceEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "openclaw-config",
  url: "https://mcp.example.test/mcp",
  env: ["GITHUB_TOKEN"],
  allowedIps: ["8.8.8.8"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.preflightMcpEntryTargets.mockResolvedValue(
    new Map([["github", { addresses: ["8.8.8.8"] }]]),
  );
  mocks.inspectSourceBridgeState.mockReturnValue({
    bridges: { github: entry },
    sources: { native: { github: entry }, legacy: {} },
  });
  mocks.inspectAgentMcpSources.mockResolvedValue({ native: { github: entry }, legacy: {} });
});

describe("source-backed MCP denied-tool policy updates", () => {
  it("refreshes validated public pins from current sources without regenerating policy (#10464)", async () => {
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValue([{ address: "1.1.1.1", family: 4 }] as never);
    try {
      await dispatchMcpBridgeCommand("alpha", ["update", "github", "--refresh-public-pins"]);
      expect(mocks.refreshMcpPublicPolicyPins).toHaveBeenCalledWith(
        "alpha",
        entry,
        { addresses: ["1.1.1.1"] },
        { gatewayName: "nemoclaw-9090", workspace: "default" },
      );
      expect(mocks.applyGeneratedPolicy).not.toHaveBeenCalled();
      expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
      expect(entry.allowedIps).toEqual(["8.8.8.8"]);
    } finally {
      lookup.mockRestore();
    }
  });

  it("refuses public-pin refresh when the native registration changes during DNS resolution (#10464)", async () => {
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValue([{ address: "1.1.1.1", family: 4 }] as never);
    mocks.inspectAgentMcpSources.mockResolvedValueOnce({
      native: { github: { ...entry, url: "https://other.example/mcp" } },
      legacy: {},
    });
    try {
      await expect(refreshMcpBridgePublicPins("alpha", "github")).rejects.toThrow(
        /agent MCP registration changed/,
      );
      expect(mocks.refreshMcpPublicPolicyPins).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it("refuses private DNS answers before any public-pin policy update (#10464)", async () => {
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValue([{ address: "10.20.30.40", family: 4 }] as never);
    try {
      await expect(refreshMcpBridgePublicPins("alpha", "github")).rejects.toThrow(
        /private, local, or special-use/,
      );
      expect(mocks.refreshMcpPublicPolicyPins).not.toHaveBeenCalled();
      expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it("requires separate approval to refresh a trusted-private registration (#10464)", async () => {
    const privateEntry = {
      ...entry,
      allowedIps: ["10.20.30.40"],
      trustedPrivateHost: "mcp.example.test",
    };
    mocks.inspectSourceBridgeState.mockReturnValueOnce({
      bridges: { github: privateEntry },
      sources: { native: { github: privateEntry }, legacy: {} },
    });
    await expect(refreshMcpBridgePublicPins("alpha", "github")).rejects.toThrow(
      /Trusted-private pins require explicit remove-and-add approval/,
    );
    expect(mocks.refreshMcpPublicPolicyPins).not.toHaveBeenCalled();
    expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
  });

  it("refuses to refresh pins after the bound provider disappears (#10464)", async () => {
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValue([{ address: "1.1.1.1", family: 4 }] as never);
    mocks.assertMcpProviderRecoverable.mockResolvedValueOnce({ exists: false });
    try {
      await expect(refreshMcpBridgePublicPins("alpha", "github")).rejects.toThrow(
        /provider is no longer present/,
      );
      expect(mocks.refreshMcpPublicPolicyPins).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it("removes the old route before applying and publishing the live replacement (#11115)", async () => {
    await updateMcpBridgeDenyTools("alpha", "github", ["submit_*", "delete_repo"]);

    const updated = expect.objectContaining({ denyTools: ["delete_repo", "submit_*"] });
    expect(mocks.removeGeneratedPolicy).toHaveBeenCalledWith("alpha", entry, {
      runtimeSelection: { gatewayName: "nemoclaw-9090", workspace: "default" },
    });
    expect(mocks.applyGeneratedPolicy).toHaveBeenCalledWith(
      "alpha",
      updated,
      { addresses: ["8.8.8.8"] },
      { runtimeSelection: { gatewayName: "nemoclaw-9090", workspace: "default" } },
    );
    expect(mocks.removeGeneratedPolicy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyGeneratedPolicy.mock.invocationCallOrder[0],
    );
  });

  it("clears denied tools from the live policy without writing durable intent (#11115)", async () => {
    mocks.inspectSourceBridgeState.mockReturnValueOnce({
      bridges: { github: { ...entry, denyTools: ["delete_repo"] } },
      sources: {
        native: { github: { ...entry, denyTools: ["delete_repo"] } },
        legacy: {},
      },
    });

    await updateMcpBridgeDenyTools("alpha", "github", []);

    expect(mocks.applyGeneratedPolicy.mock.calls[0]?.[1]).not.toHaveProperty("denyTools");
  });

  it("rejects denied-tool update when an allowlist is active to prevent policy widening", async () => {
    mocks.inspectSourceBridgeState.mockReturnValueOnce({
      bridges: { github: { ...entry, allowTools: ["read_issue"] } },
      sources: { native: { github: { ...entry, allowTools: ["read_issue"] } }, legacy: {} },
    });
    mocks.inspectAgentMcpSources.mockResolvedValueOnce({
      native: { github: { ...entry, allowTools: ["read_issue"] } },
      legacy: {},
    });

    await expect(updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"])).rejects.toThrow(
      /has an active allowlist.*--clear-allow-tools/,
    );

    // No policy mutation should occur when the rejection fires
    expect(mocks.applyGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
  });

  it("preserves the allowlist when the denylist is cleared on an allowlist-mode server", async () => {
    mocks.inspectSourceBridgeState.mockReturnValueOnce({
      bridges: { github: { ...entry, allowTools: ["read_issue"] } },
      sources: { native: { github: { ...entry, allowTools: ["read_issue"] } }, legacy: {} },
    });
    mocks.inspectAgentMcpSources.mockResolvedValueOnce({
      native: { github: { ...entry, allowTools: ["read_issue"] } },
      legacy: {},
    });

    await updateMcpBridgeDenyTools("alpha", "github", []);

    const updated = mocks.applyGeneratedPolicy.mock.calls[0]?.[1] as McpSourceEntry;
    expect(updated.allowTools).toEqual(["read_issue"]);
    expect(updated).not.toHaveProperty("denyTools");
  });

  it("restores the previous policy and preserves tool state after activation failure (#13479)", async () => {
    // removeGeneratedPolicy runs before applyGeneratedPolicy. When the
    // replacement fails, the prior policy must be reconstructed from the stored
    // entry so the route is not left widened and a retry re-derives the same
    // tool policy and address pins instead of dropping them.
    mocks.applyGeneratedPolicy
      .mockRejectedValueOnce(new Error("activation failed"))
      .mockResolvedValue(undefined);

    await expect(updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"])).rejects.toThrow(
      /activation failed.*mcp update github --deny-tool delete_repo/,
    );

    // The failed replacement must not be applied.
    expect(mocks.applyGeneratedPolicy).toHaveBeenCalledTimes(2);
    const failedCall = mocks.applyGeneratedPolicy.mock.calls[0];
    expect(failedCall[1]).toMatchObject({ denyTools: ["delete_repo"] });
    expect(failedCall[1]).not.toHaveProperty("allowTools");

    // The prior policy is restored from the stored entry: the original denylist
    // and address pins are re-applied, so no tool policy or pin is lost.
    const restoredCall = mocks.applyGeneratedPolicy.mock.calls[1];
    expect(restoredCall[1]).not.toHaveProperty("allowTools");
    expect(restoredCall[1]).not.toHaveProperty("denyTools");
    expect(restoredCall[1].allowedIps).toEqual(["8.8.8.8"]);
    expect(restoredCall[2]).toMatchObject({ addresses: ["8.8.8.8"] });
  });

  it("preserves the prior allowlist and pins when an allowlist update activation fails (#13479)", async () => {
    const allowlistedEntry = { ...entry, allowTools: ["read_issue"] };
    mocks.inspectSourceBridgeState.mockReturnValueOnce({
      bridges: { github: allowlistedEntry },
      sources: { native: { github: allowlistedEntry }, legacy: {} },
    });
    mocks.inspectAgentMcpSources.mockResolvedValueOnce({
      native: { github: allowlistedEntry },
      legacy: {},
    });
    mocks.applyGeneratedPolicy
      .mockRejectedValueOnce(new Error("activation failed"))
      .mockResolvedValue(undefined);

    await expect(updateMcpBridgeAllowTools("alpha", "github", ["list_issues"])).rejects.toThrow(
      /activation failed.*mcp update github --allow-tool list_issues/,
    );

    // The failed replacement must not be applied.
    expect(mocks.applyGeneratedPolicy).toHaveBeenCalledTimes(2);
    const failedCall = mocks.applyGeneratedPolicy.mock.calls[0];
    expect(failedCall[1]).toMatchObject({ allowTools: ["list_issues"] });
    expect(failedCall[1]).not.toHaveProperty("denyTools");

    // The prior allowlist and address pins are restored; the route is not left
    // in denylist mode, and no address pin is adopted without --refresh-public-pins.
    const restoredCall = mocks.applyGeneratedPolicy.mock.calls[1];
    expect(restoredCall[1]).toMatchObject({ allowTools: ["read_issue"] });
    expect(restoredCall[1]).not.toHaveProperty("denyTools");
    expect(restoredCall[1].allowedIps).toEqual(["8.8.8.8"]);
    expect(restoredCall[2]).toMatchObject({ addresses: ["8.8.8.8"] });
  });

  it("preserves the prior denylist and pins when clearing an allowlist activation fails (#13479)", async () => {
    const deniedEntry = { ...entry, allowTools: ["read_issue"], denyTools: ["delete_repo"] };
    mocks.inspectSourceBridgeState.mockReturnValueOnce({
      bridges: { github: deniedEntry },
      sources: { native: { github: deniedEntry }, legacy: {} },
    });
    mocks.inspectAgentMcpSources.mockResolvedValueOnce({
      native: { github: deniedEntry },
      legacy: {},
    });
    mocks.applyGeneratedPolicy
      .mockRejectedValueOnce(new Error("activation failed"))
      .mockResolvedValue(undefined);

    await expect(clearMcpBridgeAllowTools("alpha", "github")).rejects.toThrow(
      /activation failed.*mcp update github --clear-allow-tools/,
    );

    // The failed replacement must not be applied.
    expect(mocks.applyGeneratedPolicy).toHaveBeenCalledTimes(2);
    const failedCall = mocks.applyGeneratedPolicy.mock.calls[0];
    expect(failedCall[1]).not.toHaveProperty("allowTools");
    expect(failedCall[1]).toMatchObject({ denyTools: ["delete_repo"] });

    // The prior durable state is restored verbatim: the allowlist and denylist
    // and address pins are re-applied, so no tool policy or pin is lost and the
    // route is not left in unrestricted denylist mode.
    const restoredCall = mocks.applyGeneratedPolicy.mock.calls[1];
    expect(restoredCall[1]).toMatchObject({
      allowTools: ["read_issue"],
      denyTools: ["delete_repo"],
    });
    expect(restoredCall[1].allowedIps).toEqual(["8.8.8.8"]);
    expect(restoredCall[2]).toMatchObject({ addresses: ["8.8.8.8"] });
  });

  it("does not mutate policy when gateway selection fails (#11115)", async () => {
    mocks.ensureSandboxGatewaySelected.mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"])).rejects.toThrow(
      /gateway unavailable/,
    );
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.applyGeneratedPolicy).not.toHaveBeenCalled();
  });

  it("accepts deny-tool update when recorded public pins match fresh DNS answer", async () => {
    await updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"]);
    expect(mocks.applyGeneratedPolicy).toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).toHaveBeenCalled();
  });

  it("rejects deny-tool update when public pins drift without --refresh-public-pins", async () => {
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValue([{ address: "1.1.1.1", family: 4 }] as never);
    mocks.preflightMcpEntryTargets.mockResolvedValueOnce(
      new Map([["github", { addresses: ["1.1.1.1"] }]]),
    );
    try {
      await expect(updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"])).rejects.toThrow(
        /drifted public address pins.*--refresh-public-pins/,
      );
      expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
      expect(mocks.applyGeneratedPolicy).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it("explicit --refresh-public-pins updates public pins and then allows deny-tool update", async () => {
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValue([{ address: "1.1.1.1", family: 4 }] as never);
    try {
      await dispatchMcpBridgeCommand("alpha", ["update", "github", "--refresh-public-pins"]);
      expect(mocks.refreshMcpPublicPolicyPins).toHaveBeenCalled();
      expect(mocks.applyGeneratedPolicy).not.toHaveBeenCalled();
      expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();

      // Read the updated state after refresh
      const refreshedEntry = { ...entry, allowedIps: ["1.1.1.1"] };
      vi.clearAllMocks();
      mocks.inspectSourceBridgeState.mockReturnValue({
        bridges: { github: refreshedEntry },
        sources: { native: { github: refreshedEntry }, legacy: {} },
      });
      mocks.inspectAgentMcpSources.mockResolvedValue({
        native: { github: refreshedEntry },
        legacy: {},
      });
      mocks.preflightMcpEntryTargets.mockResolvedValue(
        new Map([["github", { addresses: ["1.1.1.1"] }]]),
      );

      await updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"]);
      expect(mocks.applyGeneratedPolicy).toHaveBeenCalled();
      expect(mocks.removeGeneratedPolicy).toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it("excludes trusted-private registrations from public-pin drift check", async () => {
    const privateEntry = {
      ...entry,
      allowedIps: ["10.20.30.40"],
      trustedPrivateHost: "mcp.example.test",
    };
    mocks.inspectSourceBridgeState.mockReturnValueOnce({
      bridges: { github: privateEntry },
      sources: { native: { github: privateEntry }, legacy: {} },
    });
    mocks.inspectAgentMcpSources.mockResolvedValueOnce({
      native: { github: privateEntry },
      legacy: {},
    });
    // Reissue real in-process trusted-private capability authority from the durable
    // private pins, matching what the SSRF preflight hands the action.
    const replay = replayTrustedPrivateEndpoint("mcp.example.test", ["10.20.30.40"], {
      requireAllPrivate: true,
    });
    mocks.preflightMcpEntryTargets.mockResolvedValueOnce(
      new Map([
        [
          "github",
          {
            addresses: replay.addresses,
            trustedPrivateHost: replay.host,
            trustedPrivateCapability: replay.trustedPrivateCapability,
          },
        ],
      ]),
    );

    // Should NOT throw drift error for trusted-private
    await updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"]);

    // Assert the resulting policy inputs rather than only the mock-call counts:
    // the durable entry must keep its trusted-private intent and exact pins,
    // carry the replacement denylist, and retain no allowlist.
    const [appliedSandbox, updatedEntry, appliedTarget] = mocks.applyGeneratedPolicy.mock
      .calls[0] as [string, McpSourceEntry, Record<string, unknown>];
    expect(appliedSandbox).toBe("alpha");
    expect(updatedEntry).toMatchObject({
      server: "github",
      trustedPrivateHost: "mcp.example.test",
      allowedIps: ["10.20.30.40"],
      denyTools: ["delete_repo"],
    });
    expect(updatedEntry).not.toHaveProperty("allowTools");
    expect(appliedTarget).toMatchObject({
      addresses: ["10.20.30.40"],
      trustedPrivateCapability: replay.trustedPrivateCapability,
      trustedPrivateHost: "mcp.example.test",
    });

    // The trusted-private capability gate must accept this entry and target.
    expect(() => assertMcpBridgePolicyTarget(updatedEntry, appliedTarget as never)).not.toThrow();
  });

  it.each([
    ["denied-tool update", () => updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"])],
    ["allowlist update", () => updateMcpBridgeAllowTools("alpha", "github", ["read_issue"])],
    ["allowlist clear", () => clearMcpBridgeAllowTools("alpha", "github")],
  ])("refuses %s on entries with conflicting live policy", async (_label, mutate) => {
    // A conflicted entry must never feed a replacement policy: reusing its
    // tool state could silently widen access (e.g. an all-invalid allowlist
    // would otherwise fall through to unrestricted denylist mode).
    const conflicted = {
      ...entry,
      policyConflict: "Live policy contains invalid tool selectors.",
    };
    mocks.inspectSourceBridgeState.mockReturnValueOnce({
      bridges: { github: conflicted },
      sources: { native: { github: conflicted }, legacy: {} },
    });

    await expect(mutate()).rejects.toThrow(/conflicting live policy/);
    expect(mocks.applyGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
  });

  it("preserves denyTools when clearing allow-tools in denylist-mode server", async () => {
    const deniedEntry = {
      ...entry,
      denyTools: ["read_issue"],
    };
    mocks.inspectSourceBridgeState.mockReturnValueOnce({
      bridges: { github: deniedEntry },
      sources: { native: { github: deniedEntry }, legacy: {} },
    });
    mocks.inspectAgentMcpSources.mockResolvedValueOnce({
      native: { github: deniedEntry },
      legacy: {},
    });

    await clearMcpBridgeAllowTools("alpha", "github");

    const updated = mocks.applyGeneratedPolicy.mock.calls[0]?.[1] as McpSourceEntry;
    expect(updated.denyTools).toEqual(["read_issue"]);
    expect(updated).not.toHaveProperty("allowTools");
  });
});
