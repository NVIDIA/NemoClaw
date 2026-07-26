// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as sandboxState from "../../state/sandbox";
import { runRebuildRestorePhase } from "./rebuild-restore-phase";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rebuild restore target forwarding", () => {
  it("forwards the recreated target identity and explicit custom-image capability", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const restoreRecreatedSandboxState = vi
      .spyOn(sandboxState, "restoreRecreatedSandboxState")
      .mockReturnValue({
        success: true,
        restoredDirs: [],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      });

    runRebuildRestorePhase({
      sandboxName: "alpha",
      targetAgentType: "langchain-deepagents-code",
      targetImageIsCustom: true,
      backupManifest: { agentType: "openclaw", backupPath: "/tmp/rebuild-backup" } as never,
      policyPresets: [],
      customPolicies: [],
      reconcileManagedDcodeObservability: false,
      log: vi.fn(),
    });

    expect(restoreRecreatedSandboxState).toHaveBeenCalledWith("alpha", "/tmp/rebuild-backup", {
      targetAgentType: "langchain-deepagents-code",
      allowCustomImageWholeStateFileRestore: true,
    });
  });
});
