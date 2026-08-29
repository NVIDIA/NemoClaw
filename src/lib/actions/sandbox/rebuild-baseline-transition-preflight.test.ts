// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertMcpDestroyNotPending: vi.fn(),
  bail: vi.fn(),
  confirmRebuildIntent: vi.fn(),
  countActiveSessions: vi.fn(),
  getSandbox: vi.fn(),
  listRetainedRecovery: vi.fn(),
  prepareTargets: vi.fn(),
}));

vi.mock("../../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/registry")>()),
  getSandbox: mocks.getSandbox,
}));

vi.mock("../../state/onboard-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/onboard-session")>()),
  listRetainedSandboxRecoveryRecords: mocks.listRetainedRecovery,
}));

vi.mock("./mcp-bridge-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-state")>()),
  assertMcpDestroyNotPending: mocks.assertMcpDestroyNotPending,
}));

vi.mock("./rebuild-preflight-confirmation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-preflight-confirmation")>()),
  confirmRebuildIntent: mocks.confirmRebuildIntent,
  countActiveSandboxSessionsForRebuild: mocks.countActiveSessions,
  createRebuildCommandContext: vi.fn(() => ({
    bail: mocks.bail,
    log: vi.fn(),
    requestedToolDisclosure: undefined,
    requestedDcodeAutoApprovalMode: undefined,
    requestedObservabilityEnabled: undefined,
    skipConfirm: true,
  })),
}));

vi.mock("./rebuild-preflight-target-phase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-preflight-target-phase")>()),
  prepareRebuildTargetPreflights: mocks.prepareTargets,
}));

import { runRebuildPreflightPhase } from "./rebuild-preflight-phase";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rebuild retained sandbox recovery preflight (#10547)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSandbox.mockReturnValue({ name: "alpha", openshellDriver: "docker" });
    mocks.listRetainedRecovery.mockReturnValue([
      {
        recordId: "f".repeat(64),
        sandboxName: "alpha",
      },
    ]);
  });

  it("stops before session probes, confirmation, MCP checks, or target preparation", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runRebuildPreflightPhase("alpha", ["--yes"])).resolves.toBeNull();

    expect(mocks.bail).toHaveBeenCalledWith(
      "Retained sandbox recovery blocks rebuild for 'alpha'.",
      1,
    );
    expect(error.mock.calls.flat().join("\n")).toContain("alpha destroy --yes");
    expect(mocks.countActiveSessions).not.toHaveBeenCalled();
    expect(mocks.assertMcpDestroyNotPending).not.toHaveBeenCalled();
    expect(mocks.confirmRebuildIntent).not.toHaveBeenCalled();
    expect(mocks.prepareTargets).not.toHaveBeenCalled();
  });
});

describe("rebuild baseline transition preflight (#7194)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRetainedRecovery.mockReturnValue([]);
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      baselineExclusionTransition: {
        id: "0b2f3297-a9ab-4c2f-80da-bf1760a1afbf",
        operation: "restore",
        exclusion: {
          version: 1,
          agent: "openclaw",
          key: "agents.openclaw.default",
          digest: "a".repeat(64),
        },
        startedAt: "2026-07-19T00:00:00.000Z",
        targetLiveDigest: "b".repeat(64),
      },
    });
  });

  it("stops before session probes, confirmation, MCP checks, or target preparation", async () => {
    await expect(runRebuildPreflightPhase("alpha", ["--yes"])).resolves.toBeNull();

    expect(mocks.bail).toHaveBeenCalledWith(
      "Pending baseline policy restore for 'agents.openclaw.default' blocks rebuild.",
      1,
    );
    expect(mocks.countActiveSessions).not.toHaveBeenCalled();
    expect(mocks.assertMcpDestroyNotPending).not.toHaveBeenCalled();
    expect(mocks.confirmRebuildIntent).not.toHaveBeenCalled();
    expect(mocks.prepareTargets).not.toHaveBeenCalled();
  });
});

describe("rebuild MCP destroy marker preflight (#7794)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRetainedRecovery.mockReturnValue([]);
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      mcp: {
        bridges: {},
        destroyPreparedAt: "2026-06-27T01:00:00.000Z",
      },
    });
    mocks.assertMcpDestroyNotPending.mockImplementation(() => {
      throw new Error("Sandbox 'alpha' has an incomplete MCP destroy transaction");
    });
  });

  it("prints the safe-abort diagnostic and stops before later rebuild phases", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runRebuildPreflightPhase("alpha", ["--yes"])).resolves.toBeNull();

    const output = error.mock.calls.flat().join("\n");
    expect(output).toContain("Rebuild preflight failed:");
    expect(output).toContain("a pending MCP destroy transaction blocks rebuild.");
    expect(output).toContain("Resolve the pending MCP state before retrying rebuild.");
    expect(output).toContain("Aborting rebuild");
    expect(output).toContain("sandbox is untouched, no data was lost.");
    expect(mocks.bail).toHaveBeenCalledWith(
      "Sandbox 'alpha' has an incomplete MCP destroy transaction",
    );
    expect(mocks.confirmRebuildIntent).not.toHaveBeenCalled();
    expect(mocks.prepareTargets).not.toHaveBeenCalled();
  });
});
