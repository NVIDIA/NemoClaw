// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createSandboxRecreateProtection } from "./sandbox-recreate-protection";

describe("createSandboxRecreateProtection", () => {
  it("forwards one custom-image protection context to every recreation path (#6108)", () => {
    const note = vi.fn();
    const sandboxEntry = {
      name: "my-assistant",
      agent: "openclaw" as const,
      fromDockerfile: "/tmp/Dockerfile.custom",
    };
    const selectPreUpgradeBackupForCreate = vi.fn(() => "/tmp/backup");
    const resolveNotReadyOutcome = vi.fn(() => ({
      kind: "proceed" as const,
      restoreBackupPath: "/tmp/backup",
    }));
    const backupResult = {
      ok: true,
      backup: null,
      failureKind: "none" as const,
    };
    const backupSandboxBeforeRecreate = vi.fn(() => backupResult);
    const protection = createSandboxRecreateProtection(
      {
        sandboxName: "my-assistant",
        sandboxEntry,
        customOpenClawImage: true,
        note,
      },
      {
        selectPreUpgradeBackupForCreate,
        resolveNotReadyOutcome,
        backupSandboxBeforeRecreate,
      },
    );

    expect(protection.selectPreUpgradeBackup(true)).toBe("/tmp/backup");
    expect(selectPreUpgradeBackupForCreate).toHaveBeenCalledWith({
      liveExists: true,
      hasExistingRegistryEntry: true,
      existingSandboxEntry: sandboxEntry,
      requireOpenClawImagePluginProvenance: true,
      sandboxName: "my-assistant",
      note,
    });

    expect(protection.resolveNotReadyOutcome()).toEqual({
      kind: "proceed",
      restoreBackupPath: "/tmp/backup",
    });
    expect(resolveNotReadyOutcome).toHaveBeenCalledWith("my-assistant", note, sandboxEntry, true);

    expect(protection.backup()).toBe(backupResult);
    expect(backupSandboxBeforeRecreate).toHaveBeenCalledWith({
      sandboxName: "my-assistant",
      sandboxEntry,
      requireOpenClawImagePluginProvenance: true,
    });
  });
});
