// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBridgeEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  assertMcpAdapterConfigMutationsAllowed: vi.fn(),
  assertMcpAdapterTeardownRuntimeCapabilities: vi.fn(),
  assertMcpDestroySnapshotCurrent: vi.fn(),
  detachProvider: vi.fn(),
  discardSafeIncompleteMcpAdds: vi.fn(),
  getSandboxOrThrow: vi.fn(),
  removeGeneratedPolicy: vi.fn(),
  restoreExistingMcpBridgeRuntime: vi.fn(),
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
const HERMES_ENTRY = { ...ENTRY, agent: "hermes", adapter: "hermes-config" };
const HERMES_SANDBOX = {
  name: "alpha",
  agent: "hermes",
  mcp: { bridges: { github: HERMES_ENTRY } },
};
const PREPARED_SANDBOX = {
  ...SANDBOX,
  mcp: { bridges: { github: ENTRY }, destroyPreparedAt: "2026-08-27T00:00:00Z" },
};
const PENDING_SANDBOX = {
  ...SANDBOX,
  mcp: { bridges: { github: ENTRY }, destroyPendingAt: "2026-08-27T00:00:00Z" },
};

vi.mock("./mcp-bridge-adapter-teardown", () => ({
  rollbackScrubbedMcpAdapters: vi.fn(() => []),
  scrubManagedMcpAdapterOrThrow: mocks.scrubManagedMcpAdapterOrThrow,
}));

vi.mock("./mcp-bridge-policy", () => ({
  removeGeneratedPolicy: mocks.removeGeneratedPolicy,
}));

vi.mock("./mcp-bridge-destroy-preflight", () => ({
  assertMcpDestroySnapshotCurrent: mocks.assertMcpDestroySnapshotCurrent,
  cloneMcpBridgeEntry: (entry: McpBridgeEntry) => ({ ...entry }),
  discardSafeIncompleteMcpAdds: mocks.discardSafeIncompleteMcpAdds,
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
  restoreExistingMcpBridgeRuntime: mocks.restoreExistingMcpBridgeRuntime,
}));

vi.mock("./mcp-bridge-runtime-capabilities", () => ({
  assertMcpAdapterConfigMutationsAllowed: mocks.assertMcpAdapterConfigMutationsAllowed,
  assertMcpAdapterTeardownRuntimeCapabilities: mocks.assertMcpAdapterTeardownRuntimeCapabilities,
}));

vi.mock("./mcp-bridge-state", () => ({
  bridgeState: (sandbox: { mcp?: { bridges?: Record<string, McpBridgeEntry> } }) =>
    sandbox.mcp?.bridges ?? {},
  ensureSandboxGatewaySelected: vi.fn(async () => undefined),
  getSandboxOrThrow: mocks.getSandboxOrThrow,
  nowIso: () => "2026-08-27T00:00:00Z",
}));

vi.mock("./mcp-bridge-validation", () => ({
  validateSandboxName: vi.fn(),
}));

vi.mock("../../state/registry", () => ({
  getSandbox: vi.fn(() => SANDBOX),
  updateSandbox: mocks.updateSandbox,
}));

import {
  prepareMcpBridgesForDestroy,
  restoreMcpBridgesAfterDestroyAbort,
} from "./mcp-bridge-destroy";

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
    mocks.assertMcpDestroySnapshotCurrent.mockReset().mockReturnValue(SANDBOX);
    mocks.scrubManagedMcpAdapterOrThrow.mockReset().mockImplementation(() => ({ ...ENTRY }));
    mocks.removeGeneratedPolicy.mockReset();
    mocks.restoreExistingMcpBridgeRuntime.mockReset().mockResolvedValue(undefined);
    mocks.detachProvider.mockReset().mockReturnValue("detached");
    mocks.waitForDetachedMcpCredential.mockReset();
    mocks.updateSandbox.mockReset().mockReturnValue(SANDBOX);
    mocks.getSandboxOrThrow.mockReset().mockReturnValue(SANDBOX);
    mocks.discardSafeIncompleteMcpAdds.mockReset().mockResolvedValue(SANDBOX);
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

  it("keeps MCP policy and provider state under --force when adapter mutation is refused", async () => {
    mocks.assertMcpAdapterConfigMutationsAllowed.mockImplementation(() => {
      throw new Error(SHIELDS_REFUSAL);
    });
    const preparation = await prepareMcpBridgesForDestroy("alpha", { force: true });
    expect(preparation.adapterScrubSkipped).toBe(true);
    expect(preparation.scrubbedAdapterEntries).toEqual([]);
    expect(preparation.detachedProviderEntries).toEqual([]);
    expect(mocks.scrubManagedMcpAdapterOrThrow).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    expect(mocks.waitForDetachedMcpCredential).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("tolerates a refused teardown capability probe under --force", async () => {
    mocks.assertMcpAdapterTeardownRuntimeCapabilities.mockImplementation(() => {
      throw new Error(SHIELDS_REFUSAL);
    });
    const preparation = await prepareMcpBridgesForDestroy("alpha", { force: true });
    expect(preparation.adapterScrubSkipped).toBe(true);
    expect(preparation.scrubbedAdapterEntries).toEqual([]);
    expect(preparation.detachedProviderEntries).toEqual([]);
    expect(mocks.scrubManagedMcpAdapterOrThrow).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    expect(mocks.waitForDetachedMcpCredential).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("does not bypass a Hermes config-mutation refusal under --force", async () => {
    mocks.getSandboxOrThrow.mockReturnValue(HERMES_SANDBOX);
    mocks.discardSafeIncompleteMcpAdds.mockResolvedValue(HERMES_SANDBOX);
    mocks.assertMcpAdapterConfigMutationsAllowed.mockImplementation(() => {
      throw new Error(SHIELDS_REFUSAL);
    });

    await expect(prepareMcpBridgesForDestroy("alpha", { force: true })).rejects.toThrow(
      SHIELDS_REFUSAL,
    );

    expect(mocks.scrubManagedMcpAdapterOrThrow).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("does not mutate MCP state when deletion aborts after forced preparation", async () => {
    mocks.assertMcpAdapterConfigMutationsAllowed.mockImplementation(() => {
      throw new Error(SHIELDS_REFUSAL);
    });
    const preparation = await prepareMcpBridgesForDestroy("alpha", { force: true });

    await expect(restoreMcpBridgesAfterDestroyAbort("alpha", preparation)).resolves.toBeUndefined();

    expect(mocks.assertMcpDestroySnapshotCurrent).not.toHaveBeenCalled();
    expect(mocks.restoreExistingMcpBridgeRuntime).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
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

  it("retries a prepared destroy without the config-mutation preflight (#10469)", async () => {
    // Phase one already scrubbed the adapter, so this pass mutates nothing in
    // the sandbox. A posture that legitimately refuses a first attempt must not
    // strand recovery of an interrupted destroy.
    mocks.assertMcpAdapterConfigMutationsAllowed.mockImplementation(() => {
      throw new Error(SHIELDS_REFUSAL);
    });
    mocks.getSandboxOrThrow.mockReturnValue(PREPARED_SANDBOX);
    mocks.discardSafeIncompleteMcpAdds.mockResolvedValue(PREPARED_SANDBOX);

    const preparation = await prepareMcpBridgesForDestroy("alpha");

    expect(preparation.destroyAlreadyPrepared).toBe(true);
    expect(preparation.adapterScrubSkipped).toBeUndefined();
    expect(mocks.assertMcpAdapterConfigMutationsAllowed).not.toHaveBeenCalled();
    expect(mocks.scrubManagedMcpAdapterOrThrow).not.toHaveBeenCalled();
  });

  it("retries a pending destroy without the config-mutation preflight (#10469)", async () => {
    mocks.assertMcpAdapterConfigMutationsAllowed.mockImplementation(() => {
      throw new Error(SHIELDS_REFUSAL);
    });
    mocks.getSandboxOrThrow.mockReturnValue(PENDING_SANDBOX);
    mocks.discardSafeIncompleteMcpAdds.mockResolvedValue(PENDING_SANDBOX);

    const preparation = await prepareMcpBridgesForDestroy("alpha");

    expect(preparation.destroyAlreadyPending).toBe(true);
    expect(mocks.assertMcpAdapterConfigMutationsAllowed).not.toHaveBeenCalled();
  });
});
