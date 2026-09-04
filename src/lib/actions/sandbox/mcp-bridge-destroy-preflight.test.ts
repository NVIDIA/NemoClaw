// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  assertGeneratedPolicyRegistrationMutationSafe: vi.fn(),
  ensureSandboxGatewaySelected: vi.fn(),
  getMcpProviderInspectionRuntimeSelection: vi.fn(),
  getSandboxOrThrow: vi.fn(),
  inspectMcpProvider: vi.fn(),
  removeGeneratedPolicy: vi.fn(),
  setBridgeState: vi.fn(),
}));

vi.mock("./mcp-bridge-policy", () => ({
  assertGeneratedPolicyRegistrationMutationSafe:
    mocks.assertGeneratedPolicyRegistrationMutationSafe,
  removeGeneratedPolicy: mocks.removeGeneratedPolicy,
}));

vi.mock("./mcp-bridge-provider", () => ({
  getMcpProviderInspectionRuntimeSelection: mocks.getMcpProviderInspectionRuntimeSelection,
  inspectMcpProvider: mocks.inspectMcpProvider,
  providerMatchesManagedCredential: vi.fn(),
  providerShapeDetail: vi.fn(),
}));

vi.mock("./mcp-bridge-state", () => ({
  bridgeState: (sandbox: SandboxEntry) => sandbox.mcp?.bridges ?? {},
  ensureSandboxGatewaySelected: mocks.ensureSandboxGatewaySelected,
  getSandboxOrThrow: mocks.getSandboxOrThrow,
  setBridgeState: mocks.setBridgeState,
}));

vi.mock("./mcp-bridge-validation", () => ({
  assertAuthenticatedBridgeEntry: vi.fn(),
  validateSandboxName: vi.fn(),
}));

import { discardSafeIncompleteMcpAdds } from "./mcp-bridge-destroy-preflight";

const preparedEntry: McpBridgeEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  policyName: "mcp-bridge-github",
  addedAt: "2026-09-01T00:00:00.000Z",
  addState: "prepared",
};

describe("incomplete MCP add discard", () => {
  beforeEach(() => {
    mocks.assertGeneratedPolicyRegistrationMutationSafe.mockReset();
    mocks.ensureSandboxGatewaySelected.mockReset();
    mocks.getMcpProviderInspectionRuntimeSelection.mockReset().mockImplementation(() => {
      throw new Error("runtime selection resolved for a prepared-only discard");
    });
    mocks.getSandboxOrThrow.mockReset().mockReturnValue({
      name: "alpha",
      agent: "openclaw",
    });
    mocks.inspectMcpProvider.mockReset();
    mocks.removeGeneratedPolicy.mockReset();
    mocks.setBridgeState.mockReset();
  });

  it("drops a prepared-only manifest before resolving runtime authority (#10514)", async () => {
    const sandbox: SandboxEntry = {
      name: "alpha",
      agent: "openclaw",
      mcp: { bridges: { github: preparedEntry } },
    };

    await expect(discardSafeIncompleteMcpAdds("alpha", sandbox)).resolves.toEqual({
      name: "alpha",
      agent: "openclaw",
    });

    expect(mocks.setBridgeState).toHaveBeenCalledWith("alpha", {});
    expect(mocks.getMcpProviderInspectionRuntimeSelection).not.toHaveBeenCalled();
    expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
    expect(mocks.inspectMcpProvider).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.assertGeneratedPolicyRegistrationMutationSafe).not.toHaveBeenCalled();
  });
});
