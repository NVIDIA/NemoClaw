// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpSourceEntry } from "./mcp-bridge-contracts";

const mocks = vi.hoisted(() => ({
  applyGeneratedPolicy: vi.fn(),
  assertGeneratedPolicyMutationSafe: vi.fn(),
  ensureSandboxGatewaySelected: vi.fn().mockResolvedValue(undefined),
  preflightMcpEntryTargets: vi
    .fn()
    .mockResolvedValue(new Map([["github", { addresses: ["8.8.8.8"] }]])),
  removeGeneratedPolicy: vi.fn(),
  inspectSourceBridgeState: vi.fn(),
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
}));
vi.mock("./mcp-bridge-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-provider")>()),
  assertMcpProviderRecoverable: vi.fn(),
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
vi.mock("./mcp-bridge-source", () => ({
  inspectSourceBridgeState: mocks.inspectSourceBridgeState,
}));
vi.mock("./mcp-bridge-validation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-validation")>()),
  assertMcpCredentialBoundaryRuntimeVersion: vi.fn(),
}));

import { updateMcpBridgeDenyTools } from "./mcp-bridge-add-restart";

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
});

describe("source-backed MCP denied-tool policy updates", () => {
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
    mocks.applyGeneratedPolicy.mockImplementationOnce(() => {
      throw new Error("activation failed");
    });

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
