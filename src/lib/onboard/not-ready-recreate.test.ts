// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decideNonInteractiveNotReadyAction } from "./not-ready-recreate";

describe("decideNonInteractiveNotReadyAction", () => {
  it("returns exit when no installer restore intent is set", () => {
    const decision = decideNonInteractiveNotReadyAction({
      sandboxName: "my-assistant",
      installerRestoreOnRecreate: false,
      latestBackupPath: "/home/user/.nemoclaw/rebuild-backups/my-assistant/2026-07-01T06-50-40-925Z",
    });

    expect(decision).toEqual({ kind: "exit" });
  });

  it("returns exit when installer restore intent is unset even if a backup exists", () => {
    const decision = decideNonInteractiveNotReadyAction({
      sandboxName: "my-assistant",
      installerRestoreOnRecreate: false,
      latestBackupPath: null,
    });

    expect(decision).toEqual({ kind: "exit" });
  });

  it("returns recreate with the pre-upgrade backup path when installer restore intent and a backup are present", () => {
    const backupPath =
      "/home/user/.nemoclaw/rebuild-backups/my-assistant/2026-07-01T06-50-40-925Z";
    const decision = decideNonInteractiveNotReadyAction({
      sandboxName: "my-assistant",
      installerRestoreOnRecreate: true,
      latestBackupPath: backupPath,
    });

    expect(decision.kind).toBe("recreate");
    if (decision.kind === "recreate") {
      expect(decision.restoreBackupPath).toBe(backupPath);
      expect(decision.note).toContain("my-assistant");
      expect(decision.note).toContain("recreating and restoring pre-upgrade backup");
    }
  });

  it("returns recreate without a backup when installer restore intent is set but no backup exists", () => {
    const decision = decideNonInteractiveNotReadyAction({
      sandboxName: "preserve-oc",
      installerRestoreOnRecreate: true,
      latestBackupPath: null,
    });

    expect(decision.kind).toBe("recreate");
    if (decision.kind === "recreate") {
      expect(decision.restoreBackupPath).toBeNull();
      expect(decision.note).toContain("preserve-oc");
      expect(decision.note).toContain("no pre-upgrade backup found");
    }
  });
});
