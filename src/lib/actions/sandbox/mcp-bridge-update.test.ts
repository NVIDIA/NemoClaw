// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBridgeEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  applyRecordedGeneratedPolicy: vi.fn(),
  assertGeneratedPolicyRegistrationMutationSafe: vi.fn(),
  assertHermesPortableCommandUnavailable: vi.fn(),
  assertMcpCredentialBoundaryRuntimeVersion: vi.fn(),
  ensureSandboxGatewaySelected: vi.fn().mockResolvedValue(undefined),
  preflightMcpEntryTargets: vi
    .fn()
    .mockResolvedValue(new Map([["github", { addresses: ["8.8.8.8"] }]])),
  removeGeneratedPolicy: vi.fn(),
  writeBridgeEntry: vi.fn(),
}));

vi.mock("../../onboard/experimental/portable-agent-lifecycle", () => ({
  assertHermesPortableCommandUnavailable: mocks.assertHermesPortableCommandUnavailable,
}));
vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withMcpLifecycleLock: vi.fn((_sandboxName: string, action: () => unknown) => action()),
}));
vi.mock("./mcp-bridge-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-bridge-policy")>();
  return {
    ...actual,
    applyRecordedGeneratedPolicy: mocks.applyRecordedGeneratedPolicy,
    assertGeneratedPolicyRegistrationMutationSafe:
      mocks.assertGeneratedPolicyRegistrationMutationSafe,
    removeGeneratedPolicy: mocks.removeGeneratedPolicy,
  };
});
vi.mock("./mcp-bridge-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-bridge-provider")>();
  return {
    ...actual,
    getMcpProviderInspectionRuntimeSelection: vi.fn(() => ({
      gatewayName: "nemoclaw-9090",
      workspace: "default",
    })),
    preflightMcpEntryTargets: mocks.preflightMcpEntryTargets,
  };
});
vi.mock("./mcp-bridge-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-bridge-state")>();
  return {
    ...actual,
    assertMcpDestroyNotPending: vi.fn(),
    bridgeState: vi.fn(() => ({ github: entry })),
    ensureSandboxGatewaySelected: mocks.ensureSandboxGatewaySelected,
    getSandboxOrThrow: vi.fn(() => ({ name: "alpha", agent: "openclaw" })),
    nowIso: vi.fn(() => "2026-09-06T00:00:00.000Z"),
    writeBridgeEntry: mocks.writeBridgeEntry,
  };
});
vi.mock("./mcp-bridge-validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-bridge-validation")>();
  return {
    ...actual,
    assertMcpCredentialBoundaryRuntimeVersion: mocks.assertMcpCredentialBoundaryRuntimeVersion,
  };
});

import * as state from "./mcp-bridge-state";
import { updateMcpBridgeDenyTools } from "./mcp-bridge-add-restart";

const entry: McpBridgeEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://mcp.example.test/mcp",
  env: ["GITHUB_TOKEN"],
  allowedIps: ["8.8.8.8"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
  addedAt: "2026-09-05T00:00:00.000Z",
};

beforeEach(() => vi.clearAllMocks());

describe("MCP denied-tool policy updates", () => {
  it("persists replacement intent before policy activation (#11115)", async () => {
    await updateMcpBridgeDenyTools("alpha", "github", ["submit_*", "delete_repo"]);

    const updatedEntry = expect.objectContaining({
      denyTools: ["delete_repo", "submit_*"],
      updatedAt: "2026-09-06T00:00:00.000Z",
    });
    expect(mocks.writeBridgeEntry).toHaveBeenCalledWith("alpha", updatedEntry);
    expect(mocks.applyRecordedGeneratedPolicy).toHaveBeenCalledWith("alpha", updatedEntry, {
      gatewayName: "nemoclaw-9090",
      workspace: "default",
    });
    expect(mocks.writeBridgeEntry.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyRecordedGeneratedPolicy.mock.invocationCallOrder[0],
    );
    expect(mocks.removeGeneratedPolicy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writeBridgeEntry.mock.invocationCallOrder[0],
    );
  });

  it("clears the persisted denied-tool list explicitly (#11115)", async () => {
    vi.mocked(state.bridgeState).mockReturnValueOnce({
      github: { ...entry, denyTools: ["delete_repo"] },
    });

    await updateMcpBridgeDenyTools("alpha", "github", []);

    expect(mocks.writeBridgeEntry).toHaveBeenCalledWith(
      "alpha",
      expect.not.objectContaining({ denyTools: expect.anything() }),
    );
  });

  it("retains desired intent when policy activation fails (#11115)", async () => {
    mocks.applyRecordedGeneratedPolicy.mockImplementationOnce(() => {
      throw new Error("activation failed");
    });

    await expect(updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"])).rejects.toThrow(
      /intent was saved.*mcp restart github/,
    );
    expect(mocks.writeBridgeEntry).toHaveBeenCalledOnce();
    expect(mocks.removeGeneratedPolicy).toHaveBeenCalledOnce();
  });

  it("rejects invalid stored policy state before persisting an update (#11115)", async () => {
    mocks.assertGeneratedPolicyRegistrationMutationSafe.mockImplementationOnce(() => {
      throw new Error("stored target has no pins");
    });

    await expect(updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"])).rejects.toThrow(
      /stored target has no pins/,
    );
    expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
    expect(mocks.writeBridgeEntry).not.toHaveBeenCalled();
    expect(mocks.applyRecordedGeneratedPolicy).not.toHaveBeenCalled();
  });

  it("keeps registry state unchanged when gateway selection fails (#11115)", async () => {
    mocks.ensureSandboxGatewaySelected.mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"])).rejects.toThrow(
      /gateway unavailable/,
    );
    expect(mocks.writeBridgeEntry).not.toHaveBeenCalled();
    expect(mocks.applyRecordedGeneratedPolicy).not.toHaveBeenCalled();
  });

  it("rejects incomplete add state before policy mutation (#11115)", async () => {
    vi.mocked(state.bridgeState).mockReturnValueOnce({
      github: { ...entry, addState: "prepared" },
    });

    await expect(updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"])).rejects.toThrow(
      /incomplete add transaction/,
    );
    expect(mocks.writeBridgeEntry).not.toHaveBeenCalled();
    expect(mocks.applyRecordedGeneratedPolicy).not.toHaveBeenCalled();
  });

  it("leaves intent unchanged when the old policy cannot be removed (#11115)", async () => {
    mocks.removeGeneratedPolicy.mockImplementationOnce(() => {
      throw new Error("remove failed");
    });

    await expect(updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"])).rejects.toThrow(
      "remove failed",
    );

    expect(mocks.writeBridgeEntry).not.toHaveBeenCalled();
    expect(mocks.applyRecordedGeneratedPolicy).not.toHaveBeenCalled();
  });

  it("records validated pins while updating a legacy public registration (#11115)", async () => {
    vi.mocked(state.bridgeState).mockReturnValueOnce({
      github: { ...entry, allowedIps: undefined },
    });

    await updateMcpBridgeDenyTools("alpha", "github", ["delete_repo"]);

    expect(mocks.preflightMcpEntryTargets).toHaveBeenCalledOnce();
    expect(mocks.writeBridgeEntry).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ allowedIps: ["8.8.8.8"], denyTools: ["delete_repo"] }),
    );
  });
});
