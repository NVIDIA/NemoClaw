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

import { refreshMcpBridgePublicPins, updateMcpBridgeDenyTools } from "./mcp-bridge-add-restart";
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

  it.each([
    ["shared public pins", false, false],
    ["trusted-private sibling", true, false],
    ["conflicting sibling pins", false, true],
    ["sibling with invalid denied tools", false, false, true],
    ["sibling with endpoint path drift", false, false, false, true],
  ])(
    "refuses a public-pin refresh that would diverge from %s",
    async (
      _label,
      trustedPrivate,
      conflicting,
      policyConflict = false,
      endpointConflict = false,
    ) => {
      const sibling: McpSourceEntry = {
        ...entry,
        server: "peer",
        providerName: "alpha-mcp-peer",
        providerId: "22222222-3333-4444-8555-666666666666",
        policyName: "mcp-bridge-peer",
        url: "https://mcp.example.test/peer",
        env: ["PEER_TOKEN"],
        ...(policyConflict
          ? { policyConflict: "Live policy contains invalid denied-tool selectors." }
          : {}),
        ...(endpointConflict ? { policyEndpointConflict: "mcp.example.test:443" } : {}),
        ...(trustedPrivate
          ? { trustedPrivateHost: "mcp.example.test", allowedIps: ["10.20.30.40"] }
          : {}),
      };
      const bridges = {
        github: entry,
        peer: sibling,
        ...(conflicting
          ? {
              third: {
                ...sibling,
                server: "third",
                providerName: "alpha-mcp-third",
                providerId: "33333333-4444-4555-8666-777777777777",
                policyName: "mcp-bridge-third",
                url: "https://mcp.example.test/third",
                env: ["THIRD_TOKEN"],
                allowedIps: ["9.9.9.9"],
              },
            }
          : {}),
      };
      mocks.inspectSourceBridgeState.mockReturnValueOnce({
        bridges,
        sources: { native: bridges, legacy: {} },
      });
      const lookup = vi
        .spyOn(dns, "lookup")
        .mockResolvedValue([{ address: "1.1.1.1", family: 4 }] as never);
      try {
        await expect(refreshMcpBridgePublicPins("alpha", "github")).rejects.toThrow(
          /not refreshed.*mcp\.example\.test:443/,
        );
        expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
        expect(mocks.assertMcpProviderRecoverable).not.toHaveBeenCalled();
        expect(mocks.refreshMcpPublicPolicyPins).not.toHaveBeenCalled();
        expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
      } finally {
        lookup.mockRestore();
      }
    },
  );

  it.each([
    ["matching shared pins", "https://mcp.example.test/peer", "8.8.8.8"],
    ["another hostname", "https://other.example.test/peer", "1.1.1.1"],
    ["another port", "https://mcp.example.test:8443/peer", "1.1.1.1"],
    ["an unknown unrelated authority", "https://other.example.test/peer", "1.1.1.1", null],
    [
      "an unrelated host conflict",
      "https://other.example.test/peer",
      "1.1.1.1",
      "other.example.test:443",
    ],
    [
      "an unrelated port conflict",
      "https://mcp.example.test:8443/peer",
      "1.1.1.1",
      "mcp.example.test:8443",
    ],
  ])(
    "preserves public-pin refresh with %s",
    async (_label, url, address, policyEndpointConflict?: string | null) => {
      const sibling = {
        ...entry,
        server: "peer",
        providerName: "alpha-mcp-peer",
        providerId: "22222222-3333-4444-8555-666666666666",
        policyName: "mcp-bridge-peer",
        url,
        policyEndpointConflict,
        env: ["PEER_TOKEN"],
      };
      const bridges = { github: entry, peer: sibling };
      mocks.inspectSourceBridgeState.mockReturnValueOnce({
        bridges,
        sources: { native: bridges, legacy: {} },
      });
      const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([{ address, family: 4 }] as never);
      try {
        await refreshMcpBridgePublicPins("alpha", "github");
        expect(mocks.refreshMcpPublicPolicyPins).toHaveBeenCalledWith(
          "alpha",
          entry,
          { addresses: [address] },
          { gatewayName: "nemoclaw-9090", workspace: "default" },
        );
      } finally {
        lookup.mockRestore();
      }
    },
  );

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

  it.each([
    ["replace", ["--deny-tool", "delete_*"]],
    ["clear", ["--clear-deny-tools"]],
  ])("keeps shared public pins when denied tools %s after DNS drift", async (_mode, flags) => {
    const peer = {
      ...entry,
      server: "peer",
      url: "https://mcp.example.test/peer",
      env: ["PEER_TOKEN"],
      providerName: "alpha-mcp-peer",
      providerId: "22222222-3333-4444-8555-666666666666",
      policyName: "mcp-bridge-peer",
    };
    const bridges = { github: entry, peer };
    mocks.inspectSourceBridgeState.mockReturnValueOnce({
      bridges,
      sources: { native: bridges, legacy: {} },
    });
    mocks.preflightMcpEntryTargets.mockResolvedValueOnce(
      new Map([["github", { addresses: ["1.1.1.1"] }]]),
    );

    await dispatchMcpBridgeCommand("alpha", ["update", "github", ...flags]);

    expect(mocks.applyGeneratedPolicy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ allowedIps: ["8.8.8.8"], env: ["GITHUB_TOKEN"] }),
      { addresses: ["8.8.8.8"] },
      { runtimeSelection: { gatewayName: "nemoclaw-9090", workspace: "default" } },
    );
    expect(mocks.removeGeneratedPolicy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyGeneratedPolicy.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ["conflicting public pins on replace", ["delete_*"], ["9.9.9.9"], false, true],
    ["conflicting public pins on clear", [], ["9.9.9.9"], false, true],
    ["trusted-private sibling on replace", ["delete_*"], ["10.20.30.40"], true, false],
    ["trusted-private sibling on clear", [], ["10.20.30.40"], true, false],
    ["invalid public sibling pins on replace", ["delete_*"], ["127.0.0.1"], false, false],
    ["invalid public sibling pins on clear", [], ["127.0.0.1"], false, false],
    ["sibling with invalid denied tools on replace", ["delete_*"], ["9.9.9.9"], false, true, true],
    ["sibling with invalid denied tools on clear", [], ["9.9.9.9"], false, true, true],
    [
      "sibling with endpoint path drift on replace",
      ["delete_*"],
      ["9.9.9.9"],
      false,
      false,
      false,
      true,
    ],
    ["sibling with endpoint path drift on clear", [], ["9.9.9.9"], false, false, false, true],
  ])(
    "rejects denied-tool changes before mutation with %s",
    async (
      _label,
      denyTools,
      pins,
      privatePeer,
      conflict,
      policyConflict = false,
      endpointConflict = false,
    ) => {
      const peer = {
        ...entry,
        server: "peer",
        url: "https://mcp.example.test/peer",
        env: ["PEER_TOKEN"],
        providerName: "alpha-mcp-peer",
        providerId: "22222222-3333-4444-8555-666666666666",
        policyName: "mcp-bridge-peer",
        allowedIps: pins,
        ...(endpointConflict ? { policyEndpointConflict: "mcp.example.test:443" } : {}),
        ...(policyConflict
          ? { policyConflict: "Live policy contains invalid denied-tool selectors." }
          : {}),
        ...(privatePeer ? { trustedPrivateHost: "mcp.example.test" } : {}),
      };
      const bridges = {
        github: entry,
        peer,
        ...(conflict
          ? {
              third: {
                ...peer,
                policyConflict: undefined,
                server: "third",
                url: "https://mcp.example.test/third",
                env: ["THIRD_TOKEN"],
                providerName: "alpha-mcp-third",
                providerId: "33333333-4444-4555-8666-777777777777",
                policyName: "mcp-bridge-third",
                allowedIps: ["8.8.8.8"],
              },
            }
          : {}),
      };
      mocks.inspectSourceBridgeState.mockReturnValue({
        bridges,
        sources: { native: bridges, legacy: {} },
      });
      await expect(updateMcpBridgeDenyTools("alpha", "github", denyTools)).rejects.toThrow(
        /not updated|private, local, or special-use address pin/,
      );
      expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
      expect(mocks.assertMcpProviderRecoverable).not.toHaveBeenCalled();
      expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
      expect(mocks.applyGeneratedPolicy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["replace", ["delete_*"], "https://other.example.test/peer", null],
    ["clear", [], "https://other.example.test/peer", null],
    ["replace", ["delete_*"], "https://other.example.test/peer", "other.example.test:443"],
    ["clear", [], "https://other.example.test/peer", "other.example.test:443"],
    ["replace", ["delete_*"], "https://mcp.example.test:8443/peer", "mcp.example.test:8443"],
    ["clear", [], "https://mcp.example.test:8443/peer", "mcp.example.test:8443"],
  ])(
    "permits denied-tool %s despite an unrelated endpoint conflict",
    async (_mode, denyTools, url, policyEndpointConflict) => {
      const peer = {
        ...entry,
        server: "peer",
        url,
        policyEndpointConflict,
        allowedIps: ["9.9.9.9"],
      };
      const before = structuredClone(peer);
      const bridges = { github: entry, peer };
      mocks.inspectSourceBridgeState.mockReturnValueOnce({
        bridges,
        sources: { native: bridges, legacy: {} },
      });
      await updateMcpBridgeDenyTools("alpha", "github", denyTools);
      expect(mocks.removeGeneratedPolicy).toHaveBeenCalledExactlyOnceWith("alpha", entry, {
        runtimeSelection: { gatewayName: "nemoclaw-9090", workspace: "default" },
      });
      expect(mocks.applyGeneratedPolicy).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({ server: "github" }),
        { addresses: ["8.8.8.8"] },
        { runtimeSelection: { gatewayName: "nemoclaw-9090", workspace: "default" } },
      );
      expect(mocks.applyGeneratedPolicy).toHaveBeenCalledTimes(1);
      expect(mocks.applyGeneratedPolicy.mock.calls[0][1].denyTools ?? []).toEqual(denyTools);
      expect(peer).toEqual(before);
    },
  );

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

  it("leaves the route blocked with an exact retry command after activation failure (#11115)", async () => {
    mocks.applyGeneratedPolicy.mockRejectedValueOnce(new Error("activation failed"));

    await expect(updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"])).rejects.toThrow(
      /route remains blocked.*mcp update github --deny-tool delete_repo/,
    );
  });

  it("does not mutate policy when gateway selection fails (#11115)", async () => {
    mocks.ensureSandboxGatewaySelected.mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"])).rejects.toThrow(
      /gateway unavailable/,
    );
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.applyGeneratedPolicy).not.toHaveBeenCalled();
  });
});
