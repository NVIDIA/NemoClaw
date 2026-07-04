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

import { runRebuildDestroyPhase } from "./rebuild-destroy-phase";

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
});
