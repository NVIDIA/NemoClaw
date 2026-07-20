// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertMcpDestroyNotPending: vi.fn(),
  bail: vi.fn(),
  confirmRebuildIntent: vi.fn(),
  countActiveSessions: vi.fn(),
  getSandbox: vi.fn(),
  prepareTargets: vi.fn(),
}));

vi.mock("../../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/registry")>()),
  getSandbox: mocks.getSandbox,
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

describe("rebuild baseline transition preflight (#7194)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
