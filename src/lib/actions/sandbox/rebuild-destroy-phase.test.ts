// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareMcpForRebuild: vi.fn(),
  reattachMcpAfterDeleteFailure: vi.fn(),
  warnUnpreservedUserManagedFiles: vi.fn(),
}));

vi.mock("./rebuild-flow-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-flow-helpers")>()),
  warnUnpreservedUserManagedFiles: mocks.warnUnpreservedUserManagedFiles,
}));

vi.mock("./rebuild-mcp-phase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-mcp-phase")>()),
  prepareMcpForRebuild: mocks.prepareMcpForRebuild,
  reattachMcpAfterDeleteFailure: mocks.reattachMcpAfterDeleteFailure,
}));

import { runRebuildDestroyPhase, waitForRebuildDeleteAbsence } from "./rebuild-destroy-phase";

describe("rebuild destroy validation diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
    });
    mocks.reattachMcpAfterDeleteFailure.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks rebuild before MCP or sandbox mutation when baseline repair is pending (#7178)", async () => {
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: {
          name: "alpha",
          baselineExclusionTransition: {
            id: "tx-1",
            operation: "restore",
            exclusion: {
              version: 1,
              agent: "openclaw",
              key: "nous_research",
              digest: "approved-digest",
            },
            targetLiveDigest: "current-digest",
            startedAt: "2026-07-19T00:00:00.000Z",
          },
        },
        staleRecovery: false,
        backupManifest: null,
        log: vi.fn(),
        bail,
        relockShieldsIfNeeded: vi.fn(() => true),
        onDeleted: vi.fn(),
      }),
    ).rejects.toThrow("Pending baseline policy restore");

    expect(mocks.prepareMcpForRebuild).not.toHaveBeenCalled();
    expect(bail).toHaveBeenCalledWith(
      "Pending baseline policy restore for 'nous_research' blocks rebuild.",
      1,
    );
  });

  it("retains unexpected delete-edge diagnostics without logging credentials (#6195)", async () => {
    const secret = `nvapi-${"a".repeat(32)}`;
    const log = vi.fn();
    const relockShieldsIfNeeded = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "langchain-deepagents-code" },
        staleRecovery: false,
        backupManifest: null,
        log,
        bail,
        relockShieldsIfNeeded,
        validateAfterMcpPreparation: async () => {
          throw new Error(`route probe failed with ${secret}`);
        },
        onDeleted: vi.fn(),
      }),
    ).rejects.toThrow("DCode replacement validation failed before sandbox deletion.");

    const diagnostics = log.mock.calls.flat().join("\n");
    expect(diagnostics).toContain("Unexpected DCode replacement validation failure");
    expect(diagnostics).toContain("route probe failed");
    expect(diagnostics).toContain("<REDACTED>");
    expect(diagnostics).not.toContain(secret);
    expect(mocks.reattachMcpAfterDeleteFailure).toHaveBeenCalledOnce();
    expect(relockShieldsIfNeeded).toHaveBeenCalledWith(true);
  });

  it("bounds delete convergence without treating timeout or gateway errors as absence (#7194)", () => {
    let currentMs = 0;
    let attempts = 0;
    const timeout = Object.assign(new Error("sandbox get timed out"), { code: "ETIMEDOUT" });
    const probeFailures = [
      { status: null, error: timeout },
      { status: 1, stderr: "gateway transport unavailable" },
      { status: 1, stderr: 'status: NotFound, message: "gateway not found"' },
    ];
    const captureSandboxGet = vi.fn(() => {
      const failure = probeFailures[attempts % probeFailures.length];
      attempts += 1;
      return failure;
    });
    const sleep = vi.fn((milliseconds: number) => {
      currentMs += milliseconds;
    });

    expect(
      waitForRebuildDeleteAbsence("alpha", vi.fn(), {
        captureSandboxGet,
        now: () => currentMs,
        sleep,
      }),
    ).toBe(false);

    expect(captureSandboxGet.mock.calls.length).toBeGreaterThan(1);
    expect(captureSandboxGet.mock.calls.length).toBeLessThanOrEqual(20);
    expect(sleep).toHaveBeenCalled();
    expect(currentMs).toBeLessThanOrEqual(15_000);
  });
});
