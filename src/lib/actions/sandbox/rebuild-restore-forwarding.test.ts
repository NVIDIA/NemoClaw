// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { runRebuildRestorePhase } from "./rebuild-restore-phase";
import * as snapshotRestore from "./snapshot/restore-authority";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rebuild restore target forwarding", () => {
  it("forwards only the recreated target identity consumed by restore", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const restoreRecreatedSandboxState = vi
      .spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority")
      .mockResolvedValue({
        success: true,
        restoredDirs: [],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      });

    await runRebuildRestorePhase({
      sandboxName: "alpha",
      targetAgentType: "langchain-deepagents-code",
      backupManifest: { agentType: "openclaw", backupPath: "/tmp/rebuild-backup" } as never,
      log: vi.fn(),
    });

    expect(restoreRecreatedSandboxState).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ backupPath: "/tmp/rebuild-backup" }),
      {
        targetAgentType: "langchain-deepagents-code",
      },
      { getSandbox: expect.any(Function) },
    );
  });
});
