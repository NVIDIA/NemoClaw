// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBridgeEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  assertMcpAdapterConfigMutationsAllowed: vi.fn(),
  assertMcpAdapterTeardownRuntimeCapabilities: vi.fn(),
  detachProvider: vi.fn(),
  removeGeneratedPolicy: vi.fn(),
  scrubManagedMcpAdapterOrThrow: vi.fn(),
  updateSandbox: vi.fn(),
  waitForDetachedMcpCredential: vi.fn(),
}));

const ENTRY: McpBridgeEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_MCP_TOKEN"],
  providerName: "mcp-alpha-github-0123456789abcdef",
  policyName: "mcp-bridge-github",
  addedAt: "2026-08-27T00:00:00Z",
} as McpBridgeEntry;

const SANDBOX = { name: "alpha", agent: "openclaw", mcp: { bridges: { github: ENTRY } } };

vi.mock("./mcp-bridge-adapter-teardown", () => ({
  rollbackScrubbedMcpAdapters: vi.fn(() => []),
  scrubManagedMcpAdapterOrThrow: mocks.scrubManagedMcpAdapterOrThrow,
}));

vi.mock("./mcp-bridge-policy", () => ({
  removeGeneratedPolicy: mocks.removeGeneratedPolicy,
}));

vi.mock("./mcp-bridge-destroy-preflight", () => ({
  assertMcpDestroySnapshotCurrent: vi.fn(() => SANDBOX),
  cloneMcpBridgeEntry: (entry: McpBridgeEntry) => ({ ...entry }),
  discardSafeIncompleteMcpAdds: vi.fn(async () => SANDBOX),
  inspectExactMcpDestroyProvider: vi.fn(() => ({ exists: true })),
  prepareMcpBridgesForAbsentSandboxDestroy: vi.fn(),
}));

vi.mock("./mcp-bridge-provider", () => ({
  deleteProvider: vi.fn(),
  detachProvider: mocks.detachProvider,
  inspectMcpProvider: vi.fn(() => ({ exists: false })),
  waitForDetachedMcpCredential: mocks.waitForDetachedMcpCredential,
}));

vi.mock("./mcp-bridge-restart", () => ({
  restoreExistingMcpBridgeRuntime: vi.fn(async () => undefined),
}));

vi.mock("./mcp-bridge-runtime-capabilities", () => ({
  assertMcpAdapterConfigMutationsAllowed: mocks.assertMcpAdapterConfigMutationsAllowed,
  assertMcpAdapterTeardownRuntimeCapabilities: mocks.assertMcpAdapterTeardownRuntimeCapabilities,
}));

vi.mock("./mcp-bridge-state", () => ({
  bridgeState: (sandbox: { mcp?: { bridges?: Record<string, McpBridgeEntry> } }) =>
    sandbox.mcp?.bridges ?? {},
  ensureSandboxGatewaySelected: vi.fn(async () => undefined),
  getSandboxOrThrow: vi.fn(() => SANDBOX),
  nowIso: () => "2026-08-27T00:00:00Z",
}));

vi.mock("./mcp-bridge-validation", () => ({
  validateSandboxName: vi.fn(),
}));

vi.mock("../../state/registry", () => ({
  getSandbox: vi.fn(() => SANDBOX),
  updateSandbox: mocks.updateSandbox,
}));

import { prepareMcpBridgesForDestroy } from "./mcp-bridge-destroy";

// #10469: an OpenClaw sandbox whose Mcporter config is locked under the shields
// state root cannot have its retained-volume adapter entry scrubbed at all.
// Before this change `--force` failed exactly like a plain destroy, leaving the
// registry row and a running container behind with no supported way out.
const SHIELDS_REFUSAL = "OpenClaw sandbox 'alpha' has shields up or an unreadable shields posture.";

describe("prepareMcpBridgesForDestroy adapter-scrub refusal", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.assertMcpAdapterConfigMutationsAllowed.mockReset();
    mocks.assertMcpAdapterTeardownRuntimeCapabilities.mockReset();
    mocks.scrubManagedMcpAdapterOrThrow.mockReset().mockImplementation(() => ({ ...ENTRY }));
    mocks.removeGeneratedPolicy.mockReset();
    mocks.detachProvider.mockReset().mockReturnValue("detached");
    mocks.waitForDetachedMcpCredential.mockReset();
    mocks.updateSandbox.mockReset().mockReturnValue(SANDBOX);
  });

  it("rethrows a config-mutation refusal without --force and touches nothing", async () => {
    mocks.assertMcpAdapterConfigMutationsAllowed.mockImplementation(() => {
      throw new Error(SHIELDS_REFUSAL);
    });
    await expect(prepareMcpBridgesForDestroy("alpha")).rejects.toThrow(SHIELDS_REFUSAL);
    expect(mocks.scrubManagedMcpAdapterOrThrow).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("keeps the retained adapter entry under --force and still detaches the provider", async () => {
    mocks.assertMcpAdapterConfigMutationsAllowed.mockImplementation(() => {
      throw new Error(SHIELDS_REFUSAL);
    });
    const preparation = await prepareMcpBridgesForDestroy("alpha", { force: true });
    expect(preparation.adapterScrubSkipped).toContain(SHIELDS_REFUSAL);
    expect(preparation.scrubbedAdapterEntries).toEqual([]);
    expect(mocks.scrubManagedMcpAdapterOrThrow).not.toHaveBeenCalled();
    // Host-side cleanup is unaffected by the in-sandbox posture and must still
    // run, so the retained credential placeholder cannot authenticate.
    expect(mocks.removeGeneratedPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.detachProvider).toHaveBeenCalledTimes(1);
    expect(preparation.detachedProviderEntries).toHaveLength(1);
  });

  it("tolerates a refused teardown capability probe under --force", async () => {
    mocks.assertMcpAdapterTeardownRuntimeCapabilities.mockImplementation(() => {
      throw new Error(SHIELDS_REFUSAL);
    });
    const preparation = await prepareMcpBridgesForDestroy("alpha", { force: true });
    expect(preparation.adapterScrubSkipped).toContain(SHIELDS_REFUSAL);
    expect(mocks.scrubManagedMcpAdapterOrThrow).not.toHaveBeenCalled();
    expect(mocks.detachProvider).toHaveBeenCalledTimes(1);
  });

  it("rethrows a refused teardown capability probe without --force", async () => {
    mocks.assertMcpAdapterTeardownRuntimeCapabilities.mockImplementation(() => {
      throw new Error(SHIELDS_REFUSAL);
    });
    await expect(prepareMcpBridgesForDestroy("alpha")).rejects.toThrow(SHIELDS_REFUSAL);
    expect(mocks.scrubManagedMcpAdapterOrThrow).not.toHaveBeenCalled();
  });

  it("still scrubs under --force when the config is mutable", async () => {
    // Regression lock: --force must not silently degrade a destroy that can
    // still clean the retained volume properly.
    const preparation = await prepareMcpBridgesForDestroy("alpha", { force: true });
    expect(preparation.adapterScrubSkipped).toBeUndefined();
    expect(mocks.scrubManagedMcpAdapterOrThrow).toHaveBeenCalledTimes(1);
    expect(preparation.scrubbedAdapterEntries).toHaveLength(1);
  });

  it("scrubs normally without --force when the config is mutable", async () => {
    const preparation = await prepareMcpBridgesForDestroy("alpha");
    expect(preparation.adapterScrubSkipped).toBeUndefined();
    expect(mocks.scrubManagedMcpAdapterOrThrow).toHaveBeenCalledTimes(1);
  });
});
