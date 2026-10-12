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
