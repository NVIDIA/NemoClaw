// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decideNonInteractiveNotReadyAction } from "./not-ready-recreate";

describe("decideNonInteractiveNotReadyAction", () => {
  it("returns exit when installer restore intent is unset", () => {
    expect(
      decideNonInteractiveNotReadyAction({
        sandboxName: "my-assistant",
        installerRestoreOnRecreate: false,
        latestBackupPath:
          "/home/user/.nemoclaw/rebuild-backups/my-assistant/2026-07-01T06-50-40-925Z",
      }),
    ).toEqual({ kind: "exit" });
  });

  it("returns recreate with the pre-upgrade backup path when installer intent and a backup are present", () => {
    const backupPath = "/home/user/.nemoclaw/rebuild-backups/my-assistant/2026-07-01T06-50-40-925Z";
    expect(
      decideNonInteractiveNotReadyAction({
        sandboxName: "my-assistant",
        installerRestoreOnRecreate: true,
        latestBackupPath: backupPath,
      }),
    ).toMatchObject({
      kind: "recreate",
      restoreBackupPath: backupPath,
      note: expect.stringMatching(/my-assistant.*recreating and restoring pre-upgrade backup/),
    });
  });

  it("returns recreate without a backup when installer intent is set but no backup exists", () => {
    expect(
      decideNonInteractiveNotReadyAction({
        sandboxName: "preserve-oc",
        installerRestoreOnRecreate: true,
        latestBackupPath: null,
      }),
    ).toMatchObject({
      kind: "recreate",
      restoreBackupPath: null,
      note: expect.stringMatching(/preserve-oc.*no pre-upgrade backup found/),
    });
  });
});
